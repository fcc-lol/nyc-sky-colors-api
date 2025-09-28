import express from "express";
import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import cors from "cors";

// Load configuration
const config = JSON.parse(fs.readFileSync("config.json", "utf8"));

// File-based cache configuration
const CACHE_TTL = config.cache.ttlMinutes * 60 * 1000; // Convert minutes to milliseconds
const METADATA_FILE = path.join(process.cwd(), "data", "metadata.json");

// Track if an update is currently in progress
let updateInProgress = false;

const app = express();
const port = 3113;

// Enable CORS for all origins
app.use(cors());

// Create data directory if it doesn't exist
const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
  console.log("Created data directory");
}

// Serve static files from data directory
app.use("/data", express.static(dataDir));

async function getFrameData() {
  try {
    // Step 1: Get direct video URL from yt-dlp
    const videoUrl = execSync(`yt-dlp -g "${config.source.url}"`, {
      encoding: "utf8"
    }).trim();

    console.log("Video stream URL:", videoUrl);

    // Step 2: Run ffmpeg to capture one frame and pipe raw image data to stdout
    return await new Promise((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-y",
        "-i",
        videoUrl,
        "-vframes",
        "1",
        "-f",
        "image2pipe", // output an image to a pipe
        "-vcodec",
        "png", // output as PNG
        "pipe:1" // stdout
      ]);

      let chunks = [];

      ffmpeg.stdout.on("data", (chunk) => {
        chunks.push(chunk);
      });

      ffmpeg.stderr.on("data", (err) => {
        // ffmpeg logs to stderr, uncomment if debugging
        // console.error("ffmpeg:", err.toString());
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`ffmpeg exited with ${code}`));
        }
      });
    });
  } catch (err) {
    console.error("Error:", err);
    throw err;
  }
}

async function getCroppedSection(imageBuffer, x, y, width = 300, height = 300) {
  return await new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-f",
      "image2pipe",
      "-i",
      "pipe:0", // read from stdin
      "-vf",
      `crop=${width}:${height}:${x}:${y}`, // crop filter: width:height:x:y
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "pipe:1"
    ]);

    let chunks = [];

    ffmpeg.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    ffmpeg.stderr.on("data", (err) => {
      // ffmpeg logs to stderr, uncomment if debugging
      // console.error("ffmpeg crop:", err.toString());
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg crop exited with ${code}`));
      }
    });

    // Write the image buffer to ffmpeg's stdin
    ffmpeg.stdin.write(imageBuffer);
    ffmpeg.stdin.end();
  });
}

async function saveImageToFile(imageBuffer, filename) {
  try {
    const filePath = path.join(dataDir, filename);
    fs.writeFileSync(filePath, imageBuffer);
    console.log(`Saved ${filename} to data folder`);
  } catch (error) {
    console.error(`Error saving ${filename}:`, error);
  }
}

function getMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      const data = fs.readFileSync(METADATA_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("Error reading metadata:", error);
  }
  return null;
}

function saveMetadata(metadata) {
  try {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
    console.log("Metadata saved");
  } catch (error) {
    console.error("Error saving metadata:", error);
  }
}

function isCacheExpired() {
  const metadata = getMetadata();
  if (!metadata || !metadata.lastUpdated) {
    return true;
  }
  const now = Date.now();
  const age = now - metadata.lastUpdated;
  return age > CACHE_TTL;
}

function filesExist() {
  const requiredFiles = [
    "full.png",
    "crop-left.png",
    "crop-middle.png",
    "crop-right.png"
  ];
  return requiredFiles.every((file) => fs.existsSync(path.join(dataDir, file)));
}

async function getDominantColor(imageBuffer) {
  return await new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-f",
      "image2pipe",
      "-i",
      "pipe:0", // read from stdin
      "-vf",
      "scale=1:1", // scale to 1x1 pixel to get average color
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1"
    ]);

    let chunks = [];

    ffmpeg.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    ffmpeg.stderr.on("data", (err) => {
      // ffmpeg logs to stderr, uncomment if debugging
      // console.error("ffmpeg color:", err.toString());
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        const buffer = Buffer.concat(chunks);
        if (buffer.length >= 3) {
          const r = buffer[0];
          const g = buffer[1];
          const b = buffer[2];
          const hex = `#${r.toString(16).padStart(2, "0")}${g
            .toString(16)
            .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
          resolve(hex);
        } else {
          reject(new Error("Invalid color data"));
        }
      } else {
        reject(new Error(`ffmpeg color extraction exited with ${code}`));
      }
    });

    // Write the image buffer to ffmpeg's stdin
    ffmpeg.stdin.write(imageBuffer);
    ffmpeg.stdin.end();
  });
}

async function updateCacheFiles() {
  if (updateInProgress) {
    console.log("Update already in progress, skipping...");
    return;
  }

  updateInProgress = true;
  console.log("Updating cache files...");

  try {
    // Step 1: Get the full frame image once
    console.log("Getting full frame image...");
    const imageBuffer = await getFrameData();
    console.log("Got full frame buffer:", imageBuffer.length, "bytes");

    // Step 2: Get video dimensions to calculate crop positions
    const videoUrl = execSync(`yt-dlp -g "${config.source.url}"`, {
      encoding: "utf8"
    }).trim();

    const videoInfo = execSync(
      `ffprobe -v quiet -print_format json -show_streams "${videoUrl}"`,
      { encoding: "utf8" }
    );

    const streams = JSON.parse(videoInfo).streams;
    const videoStream = streams.find((s) => s.codec_type === "video");
    const width = videoStream.width;
    const height = videoStream.height;

    console.log(`Video dimensions: ${width}x${height}`);

    // Step 3: Calculate positions for crops
    const middleX = Math.floor((width - 300) / 2) - 100;
    const rightX = width - 300;

    // Step 4: Crop three sections from the single image
    console.log("Creating crops from single image...");
    const [northwestCrop, northCrop, northeastCrop] = await Promise.all([
      getCroppedSection(imageBuffer, 0, 0), // top-left
      getCroppedSection(imageBuffer, middleX, 0), // top-middle
      getCroppedSection(imageBuffer, rightX, 0) // top-right
    ]);

    console.log("All crops completed, extracting colors...");

    // Step 5: Extract dominant colors from each crop
    const [northwestColor, northColor, northeastColor] = await Promise.all([
      getDominantColor(northwestCrop),
      getDominantColor(northCrop),
      getDominantColor(northeastCrop)
    ]);

    console.log("Colors extracted:", {
      northwestColor,
      northColor,
      northeastColor
    });

    // Step 6: Save images to disk (replace previous versions)
    console.log("Saving images to disk...");
    await Promise.all([
      saveImageToFile(imageBuffer, "full.png"),
      saveImageToFile(northwestCrop, "crop-left.png"),
      saveImageToFile(northCrop, "crop-middle.png"),
      saveImageToFile(northeastCrop, "crop-right.png")
    ]);

    // Step 7: Save metadata with colors and timestamp
    const metadata = {
      lastUpdated: Date.now(),
      colors: {
        northwestColor,
        northColor,
        northeastColor
      }
    };
    saveMetadata(metadata);

    console.log("Cache update completed successfully");
  } catch (err) {
    console.error("Error updating cache files:", err);
    throw err;
  } finally {
    updateInProgress = false;
  }
}

async function getCachedData() {
  // If files don't exist at all, trigger background generation but don't wait
  if (!filesExist()) {
    console.log(
      "No cached files found, generating initial cache in background..."
    );
    // Start cache generation in background without waiting
    updateCacheFiles().catch((err) => {
      console.error("Background initial cache generation failed:", err);
    });

    // Throw error - no data available yet
    throw new Error("Cache is being generated, please try again in a moment");
  } else {
    // Files exist - check if TTL expired and trigger background update if needed
    if (isCacheExpired()) {
      console.log(
        "Cache TTL expired, triggering background update (serving cached data immediately)"
      );
      // Update in background without waiting - don't block the response
      updateCacheFiles().catch((err) => {
        console.error("Background update failed:", err);
      });
    } else {
      console.log("Cache still fresh, serving cached data");
    }
  }

  // Always return current cached data immediately (even if expired/stale)
  const metadata = getMetadata();
  if (!metadata) {
    throw new Error("No metadata available");
  }

  // Read image files
  const northwestCrop = fs.readFileSync(path.join(dataDir, "crop-left.png"));
  const northCrop = fs.readFileSync(path.join(dataDir, "crop-middle.png"));
  const northeastCrop = fs.readFileSync(path.join(dataDir, "crop-right.png"));

  return {
    northwestCrop,
    northCrop,
    northeastCrop,
    northwestColor: metadata.colors.northwestColor,
    northColor: metadata.colors.northColor,
    northeastColor: metadata.colors.northeastColor,
    lastUpdated: metadata.lastUpdated
  };
}

app.get("/api", async (req, res) => {
  try {
    const { northwestColor, northColor, northeastColor, lastUpdated } =
      await getCachedData();

    const cacheAge = Date.now() - lastUpdated;

    // Format cache age for display
    function formatCacheAge(ageMs) {
      const seconds = Math.floor(ageMs / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);

      if (hours > 0) return hours + "h " + (minutes % 60) + "m";
      if (minutes > 0) return minutes + "m " + (seconds % 60) + "s";
      return seconds + "s";
    }

    // Format timestamp in real-time
    const lastUpdatedFormatted =
      new Date(lastUpdated).toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "long",
        day: "numeric"
      }) +
      " at " +
      new Date(lastUpdated).toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true
      });

    const response = {
      colors: {
        northwest: northwestColor,
        north: northColor,
        northeast: northeastColor
      },
      images: {
        full: "/data/full.png",
        northwest: "/data/crop-left.png",
        north: "/data/crop-middle.png",
        northeast: "/data/crop-right.png"
      },
      metadata: {
        lastUpdated: {
          timestamp: lastUpdated,
          formatted: lastUpdatedFormatted
        },
        cacheAge: {
          timestamp: cacheAge,
          formatted: formatCacheAge(cacheAge)
        },
        cacheConfig: config.cache,
        source: config.source
      }
    };

    res.json(response);
  } catch (error) {
    console.error("API endpoint error:", error);
    res.status(500).json({
      error: "Failed to get API data",
      message: error.message
    });
  }
});

app.get("/", async (req, res) => {
  try {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NYC Sky Colors</title>
    <style>
        body {
            font-family: monospace;
            margin: 0;
            padding: 1.25rem;
            background-color: #f0f0f0;
            min-height: calc(100vh - 2.5rem);
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .container {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            max-width: 50rem;
            text-align: center;
            padding-bottom: 2rem;
        }
        h1 {
            color: #333;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 2rem;
            margin: 2rem 0;
            justify-items: center;
        }
        .card {
            background: white;
            padding: 1rem;
            border-radius: 2rem;
            box-shadow: 0 0.125rem 1.25rem rgba(0,0,0,0.1);
            text-align: center;
        }
        .color-swatch {
            display: block;
            width: 12rem;
            height: 12rem;
            border-radius: 1rem;
            margin: 0 auto 1rem auto;
            background-color: #e0e0e0;
        }
        .color-label {
            font-size: 1rem;
            font-weight: 500;
            text-transform: uppercase;
            color: #666;
            margin-top: 1.5rem;
        }
        .hex-code {
            font-weight: bold;
            color: #000;
            display: block;
            margin: 1rem 0 0.75rem 0;
            font-size: 2rem;
            text-transform: uppercase;
            min-height: 2.4rem;
        }
        .timestamp-info {
            font-size: 1rem;
            padding: 0.5rem 0 2rem 0;
            color: #666;
        }
        .source-link {
            margin-top: 2rem;
            text-align: center;
        }
        .source-link a {
            color: #666;
            text-decoration: none;
            font-size: 0.75rem;
            border-bottom: 0.125rem solid #ccc;
            padding-bottom: 0.125rem;
            text-transform: uppercase;
        }
        .source-link a:hover {
            color: #333;
            border-bottom-color: #333;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>NEW YORK CITY SKY COLORS</h1>
        <div class="timestamp-info">
            <span id="timestamp-display">Checking the sky...</span>
        </div>
        <div class="grid">
            <div class="card">
                <div class="color-info">
                    <div class="color-swatch" id="northwest-swatch"></div>
                    <div class="color-label">Northwest</div>
                    <div class="hex-code" id="northwest-hex"></div>
                </div>
            </div>
            <div class="card">
                <div class="color-info">
                    <div class="color-swatch" id="north-swatch"></div>
                    <div class="color-label">North</div>
                    <div class="hex-code" id="north-hex"></div>
                </div>
            </div>
            <div class="card">
                <div class="color-info">
                    <div class="color-swatch" id="northeast-swatch"></div>
                    <div class="color-label">Northeast</div>
                    <div class="hex-code" id="northeast-hex"></div>
                </div>
            </div>
        </div>
        <div class="source-link">
            <a href="#" id="source-url" target="_blank" rel="noopener">View source</a>
        </div>
    </div>

    <script>
        function formatCacheAge(ageMs) {
            const seconds = Math.floor(ageMs / 1000);
            const minutes = Math.floor(seconds / 60);
            const hours = Math.floor(minutes / 60);
            
            if (hours > 0) return hours + 'h ' + (minutes % 60) + 'm';
            if (minutes > 0) return minutes + 'm ' + (seconds % 60) + 's';
            return seconds + 's';
        }

        async function loadColors() {
            try {
                const response = await fetch('/api');
                const data = await response.json();
                
                // Set color swatches and hex codes
                document.getElementById('northwest-swatch').style.backgroundColor = data.colors.northwest;
                document.getElementById('northwest-hex').textContent = data.colors.northwest;
                
                document.getElementById('north-swatch').style.backgroundColor = data.colors.north;
                document.getElementById('north-hex').textContent = data.colors.north;
                
                document.getElementById('northeast-swatch').style.backgroundColor = data.colors.northeast;
                document.getElementById('northeast-hex').textContent = data.colors.northeast;
                
                // Update timestamp info
                document.getElementById('timestamp-display').textContent = 
                    data.metadata.lastUpdated.formatted;
                
                // Update source link
                document.getElementById('source-url').href = data.metadata.source.url;
            } catch (error) {
                console.error('Error loading colors:', error);
            }
        }

        // Load colors when page loads
        window.onload = loadColors;
    </script>
</body>
</html>`;

    res.set("Content-Type", "text/html");
    res.send(html);
  } catch (error) {
    console.error("Grid endpoint error:", error);
    res.status(500).json({
      error: "Failed to generate grid",
      message: error.message
    });
  }
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
