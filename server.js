import express from "express";
import { execSync, spawn, exec } from "child_process";
import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import cors from "cors";
import { promisify } from "util";

const execAsync = promisify(exec);

// Load configuration
const config = JSON.parse(fs.readFileSync("config.json", "utf8"));

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

async function getFrameData() {
  try {
    // Step 1: Get direct video URL from yt-dlp
    const { stdout: videoUrl } = await execAsync(
      `yt-dlp -g "${config.source.url}"`,
      {
        encoding: "utf8"
      }
    );
    const trimmedVideoUrl = videoUrl.trim();

    console.log("Video stream URL:", trimmedVideoUrl);

    // Step 2: Run ffmpeg to capture one frame and pipe raw image data to stdout
    return await new Promise((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-y",
        "-i",
        trimmedVideoUrl,
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

async function getCroppedSection(
  imageBuffer,
  x,
  y,
  width = config.crops.dimensions.width,
  height = config.crops.dimensions.height
) {
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

function getLatestColorData() {
  try {
    // Get all date folders and sort by newest first
    const dateFolders = fs
      .readdirSync(dataDir)
      .filter((item) => {
        const itemPath = path.join(dataDir, item);
        return (
          fs.statSync(itemPath).isDirectory() &&
          /^\d{4}-\d{2}-\d{2}$/.test(item)
        );
      })
      .sort((a, b) => b.localeCompare(a)); // Sort dates descending

    if (dateFolders.length === 0) {
      return null;
    }

    // Look through date folders starting with the most recent
    for (const dateFolder of dateFolders) {
      const dateFolderPath = path.join(dataDir, dateFolder);

      // Get all time files in this date folder
      const timeFiles = fs
        .readdirSync(dateFolderPath)
        .filter(
          (file) => file.endsWith(".json") && /^\d{2}-\d{2}\.json$/.test(file)
        )
        .sort((a, b) => b.localeCompare(a)); // Sort times descending

      if (timeFiles.length > 0) {
        // Read the most recent time file
        const latestTimeFile = timeFiles[0];
        const filePath = path.join(dateFolderPath, latestTimeFile);
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

        // Create timestamp from date folder and time filename (NYC timezone)
        const dateStr = dateFolder; // YYYY-MM-DD
        const timeStr = latestTimeFile.replace(".json", "").replace("-", ":"); // HH:MM

        // The file represents NYC time, so we need to convert it to a proper UTC timestamp
        // Parse the date components
        const [year, month, day] = dateStr.split("-").map(Number);
        const [hour, minute] = timeStr.split(":").map(Number);

        // Create a date object representing this time in NYC
        // We'll use a reference approach: create the date as if it's UTC, then adjust
        const utcDate = new Date(
          Date.UTC(year, month - 1, day, hour, minute, 0)
        );

        // Now we need to adjust for NYC timezone offset
        // Get the current NYC offset (this handles DST automatically)
        const testDate = new Date(year, month - 1, day);
        const nycTestTime = testDate.toLocaleString("en-US", {
          timeZone: "America/New_York"
        });
        const utcTestTime = testDate.toLocaleString("en-US", {
          timeZone: "UTC"
        });
        const nycOffset =
          new Date(utcTestTime).getTime() - new Date(nycTestTime).getTime();

        // The timestamp should represent the NYC time converted to UTC
        const timestamp = utcDate.getTime() + nycOffset;

        return {
          colors: data,
          timestamp
        };
      }
    }

    return null;
  } catch (error) {
    console.error("Error reading color data:", error);
    return null;
  }
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
    const { stdout: videoUrlOutput } = await execAsync(
      `yt-dlp -g "${config.source.url}"`,
      {
        encoding: "utf8"
      }
    );
    const videoUrl = videoUrlOutput.trim();

    const { stdout: videoInfo } = await execAsync(
      `ffprobe -v quiet -print_format json -show_streams "${videoUrl}"`,
      { encoding: "utf8" }
    );

    const streams = JSON.parse(videoInfo).streams;
    const videoStream = streams.find((s) => s.codec_type === "video");
    const width = videoStream.width;
    const height = videoStream.height;

    console.log(`Video dimensions: ${width}x${height}`);

    // Step 3: Get crop coordinates from config
    const cropCoordinates = config.crops.coordinates;

    // Step 4: Crop four sections from the single image
    console.log("Creating crops from single image...");
    const [westCrop, northWestCrop, northEastCrop, eastCrop] =
      await Promise.all([
        getCroppedSection(
          imageBuffer,
          cropCoordinates.west.x,
          cropCoordinates.west.y
        ),
        getCroppedSection(
          imageBuffer,
          cropCoordinates["north-west"].x,
          cropCoordinates["north-west"].y
        ),
        getCroppedSection(
          imageBuffer,
          cropCoordinates["north-east"].x,
          cropCoordinates["north-east"].y
        ),
        getCroppedSection(
          imageBuffer,
          cropCoordinates.east.x,
          cropCoordinates.east.y
        )
      ]);

    console.log("All crops completed, extracting colors...");

    // Step 5: Extract dominant colors from each crop
    const [westColor, northWestColor, northEastColor, eastColor] =
      await Promise.all([
        getDominantColor(westCrop),
        getDominantColor(northWestCrop),
        getDominantColor(northEastCrop),
        getDominantColor(eastCrop)
      ]);

    console.log("Colors extracted:", {
      westColor,
      northWestColor,
      northEastColor,
      eastColor
    });

    // Step 6: Save timestamped JSON file with colors
    const now = new Date();
    // Get NYC date and time components separately
    const nycDate = now.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }); // Returns "MM/DD/YYYY"

    const nycTime = now.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }); // Returns "HH:MM"

    // Convert MM/DD/YYYY to YYYY-MM-DD
    const [month, day, year] = nycDate.split("/");
    const dateFolder = `${year}-${month}-${day}`;
    const timeFilename = nycTime.replace(":", "-") + ".json"; // HH-MM.json

    const colorData = {
      west: westColor,
      "north-west": northWestColor,
      "north-east": northEastColor,
      east: eastColor
    };

    // Create date folder if it doesn't exist
    const dateFolderPath = path.join(dataDir, dateFolder);
    if (!fs.existsSync(dateFolderPath)) {
      fs.mkdirSync(dateFolderPath, { recursive: true });
      console.log(`Created date folder: ${dateFolder}`);
    }

    const filePath = path.join(dateFolderPath, timeFilename);
    fs.writeFileSync(filePath, JSON.stringify(colorData, null, 2));
    console.log(`Saved color data to ${dateFolder}/${timeFilename}`);

    console.log("Cache update completed successfully");
  } catch (err) {
    console.error("Error updating cache files:", err);
    throw err;
  } finally {
    updateInProgress = false;
  }
}

async function getCachedData() {
  // Get the latest color data
  const latestData = getLatestColorData();

  if (!latestData) {
    throw new Error(
      "No color data available. Use /update-cache to generate initial data."
    );
  }

  return {
    westColor: latestData.colors.west,
    northWestColor: latestData.colors["north-west"],
    northEastColor: latestData.colors["north-east"],
    eastColor: latestData.colors.east,
    lastUpdated: latestData.timestamp
  };
}

app.get("/api", async (req, res) => {
  try {
    const {
      westColor,
      northWestColor,
      northEastColor,
      eastColor,
      lastUpdated
    } = await getCachedData();

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
        hour12: true
      });

    // Calculate next update time based on fixed intervals (e.g., :00, :15, :30, :45)
    const now = Date.now();
    const intervalMinutes = config.cache.updateIntervalMinutes;

    // Get current time in NYC timezone
    const nycNowString = new Date(now).toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });

    // Parse the NYC time string to get components
    const [datePart, timePart] = nycNowString.split(", ");
    const [month, day, year] = datePart.split("/");
    const [hour, minute, second] = timePart.split(":");

    const currentMinutes = parseInt(minute);
    const currentHour = parseInt(hour);

    // Calculate the next 15-minute interval
    const nextIntervalMinute =
      Math.ceil(currentMinutes / intervalMinutes) * intervalMinutes;

    let nextHour = currentHour;
    let nextMinute = nextIntervalMinute;

    if (nextIntervalMinute >= 60) {
      nextHour = currentHour + 1;
      nextMinute = 0;
    }

    // Use the same timezone conversion logic as in getLatestColorData()
    // Create a UTC date with the NYC time components, then apply NYC offset
    const utcDate = new Date(
      Date.UTC(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        nextHour,
        nextMinute,
        0
      )
    );

    // Get the timezone offset for NYC on this date
    const testDate = new Date(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day)
    );
    const nycTestTime = testDate.toLocaleString("en-US", {
      timeZone: "America/New_York"
    });
    const utcTestTime = testDate.toLocaleString("en-US", { timeZone: "UTC" });
    const nycOffset =
      new Date(utcTestTime).getTime() - new Date(nycTestTime).getTime();

    // Convert NYC time to proper UTC timestamp
    const nextUpdateTime = utcDate.getTime() + nycOffset;
    const timeToNextUpdate = nextUpdateTime - now;

    // Format next update time
    const nextUpdateFormatted = new Date(nextUpdateTime).toLocaleTimeString(
      "en-US",
      {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }
    );

    const response = {
      colors: {
        west: westColor,
        "north-west": northWestColor,
        "north-east": northEastColor,
        east: eastColor
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
        nextUpdate: {
          timestamp: nextUpdateTime,
          formatted: nextUpdateFormatted,
          timeRemaining: Math.max(0, timeToNextUpdate)
        },
        updateInterval: {
          minutes: config.cache.updateIntervalMinutes,
          milliseconds: config.cache.updateIntervalMinutes * 60 * 1000
        },
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

app.get("/update-cache", async (req, res) => {
  try {
    if (updateInProgress) {
      return res.status(429).json({
        error: "Update already in progress",
        message: "Please wait for the current update to complete"
      });
    }

    // Start the update process in the background
    updateCacheFiles().catch((err) => {
      console.error("Update failed:", err);
    });

    res.json({
      message: "Update started",
      status: "processing"
    });
  } catch (error) {
    console.error("Update endpoint error:", error);
    res.status(500).json({
      error: "Failed to start update",
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
            grid-template-columns: repeat(4, 1fr);
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
        .countdown-timer {
            font-size: 0.875rem;
            color: #888;
            margin-top: 1.75rem;
        }
        .countdown-timer .time-remaining {
            font-weight: bold;
            color: #555;
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
            <div class="countdown-timer">
                <span id="countdown-display"></span>
            </div>
        </div>
        <div class="grid">
            <div class="card">
                <div class="color-info">
                    <div class="color-swatch" id="west-swatch"></div>
                    <div class="color-label">West</div>
                    <div class="hex-code" id="west-hex"></div>
                </div>
            </div>
            <div class="card">
                <div class="color-info">
                    <div class="color-swatch" id="north-west-swatch"></div>
                    <div class="color-label">North-West</div>
                    <div class="hex-code" id="north-west-hex"></div>
                </div>
            </div>
            <div class="card">
                <div class="color-info">
                    <div class="color-swatch" id="north-east-swatch"></div>
                    <div class="color-label">North-East</div>
                    <div class="hex-code" id="north-east-hex"></div>
                </div>
            </div>
            <div class="card">
                <div class="color-info">
                    <div class="color-swatch" id="east-swatch"></div>
                    <div class="color-label">East</div>
                    <div class="hex-code" id="east-hex"></div>
                </div>
            </div>
        </div>
        <div class="source-link">
            <a href="#" id="source-url" target="_blank" rel="noopener">View source</a>
        </div>
    </div>

    <script>
        let countdownInterval;
        let nextUpdateTimestamp;

        function formatTimeRemaining(milliseconds) {
            if (milliseconds <= 0) return "overdue";
            
            const totalSeconds = Math.floor(milliseconds / 1000);
            const minutes = Math.round(totalSeconds / 60);
            
            if (minutes > 0) {
                return 'Next update in ' + minutes + ' minute' + (minutes !== 1 ? 's' : '');
            } else {
                return 'Next update in less than a minute';
            }
        }

        function updateCountdown() {
            if (!nextUpdateTimestamp) return;
            
            const now = Date.now();
            const timeRemaining = nextUpdateTimestamp - now;
            
            const countdownElement = document.getElementById('countdown-display');
            
            if (timeRemaining <= 0) {
                countdownElement.textContent = "Updating...";
                countdownElement.style.color = "#888";
                countdownElement.style.fontWeight = "normal";
                // Try to refresh data when countdown reaches zero
                if (timeRemaining > -60000) { // Only refresh once when just overdue
                    loadColors();
                }
            } else {
                countdownElement.textContent = formatTimeRemaining(timeRemaining);
                countdownElement.style.color = "#888";
            }
        }

        async function loadColors() {
            try {
                const response = await fetch('/api');
                const data = await response.json();
                
                // Set color swatches and hex codes
                document.getElementById('west-swatch').style.backgroundColor = data.colors.west;
                document.getElementById('west-hex').textContent = data.colors.west;
                
                document.getElementById('north-west-swatch').style.backgroundColor = data.colors['north-west'];
                document.getElementById('north-west-hex').textContent = data.colors['north-west'];
                
                document.getElementById('north-east-swatch').style.backgroundColor = data.colors['north-east'];
                document.getElementById('north-east-hex').textContent = data.colors['north-east'];
                
                document.getElementById('east-swatch').style.backgroundColor = data.colors.east;
                document.getElementById('east-hex').textContent = data.colors.east;
                
                // Update timestamp info
                document.getElementById('timestamp-display').textContent = 
                    data.metadata.lastUpdated.formatted;
                
                // Update source link
                document.getElementById('source-url').href = data.metadata.source.url;
                
                // Set up countdown timer
                nextUpdateTimestamp = data.metadata.nextUpdate.timestamp;
                
                // Clear existing countdown interval
                if (countdownInterval) {
                    clearInterval(countdownInterval);
                }
                
                // Update countdown immediately
                updateCountdown();
                
                // Start countdown timer that updates every second
                countdownInterval = setInterval(updateCountdown, 1000);
                
            } catch (error) {
                console.error('Error loading colors:', error);
                document.getElementById('countdown-display').textContent = 'Unable to calculate next update';
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
