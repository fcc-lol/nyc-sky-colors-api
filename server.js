import express from "express";
import { execSync, spawn, exec } from "child_process";
import fs from "fs";
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

function formatTimeRemaining(milliseconds) {
  if (milliseconds <= 0) return "overdue";

  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.ceil(totalSeconds / 60);

  if (minutes > 0) {
    return "Next update in " + minutes + " minute" + (minutes !== 1 ? "s" : "");
  } else {
    return "Next update in less than a minute";
  }
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

function getColorDataForDateTime(dateStr, timeStr) {
  try {
    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error("Invalid date format. Expected YYYY-MM-DD");
    }

    // Validate time format (H:MM or HH:MM)
    if (!/^\d{1,2}:\d{2}$/.test(timeStr)) {
      throw new Error("Invalid time format. Expected H:MM or HH:MM");
    }

    // Normalize time to HH:MM format (pad single digit hours)
    const timeParts = timeStr.split(":");
    const normalizedTimeStr =
      timeParts[0].padStart(2, "0") + ":" + timeParts[1];

    // Check if date folder exists
    const dateFolderPath = path.join(dataDir, dateStr);
    if (!fs.existsSync(dateFolderPath)) {
      throw new Error(`No data available for date ${dateStr}`);
    }

    // Convert normalized time to filename format (HH-MM.json)
    const timeFilename = normalizedTimeStr.replace(":", "-") + ".json";
    const filePath = path.join(dateFolderPath, timeFilename);

    // Check if time file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `No data available for ${dateStr} at ${normalizedTimeStr}`
      );
    }

    // Read the color data
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

    // Create timestamp from date and normalized time (NYC timezone)
    const [year, month, day] = dateStr.split("-").map(Number);
    const [hour, minute] = normalizedTimeStr.split(":").map(Number);

    // Create a date object representing this time in NYC
    const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

    // Adjust for NYC timezone offset
    const testDate = new Date(year, month - 1, day);
    const nycTestTime = testDate.toLocaleString("en-US", {
      timeZone: "America/New_York"
    });
    const utcTestTime = testDate.toLocaleString("en-US", {
      timeZone: "UTC"
    });
    const nycOffset =
      new Date(utcTestTime).getTime() - new Date(nycTestTime).getTime();

    const timestamp = utcDate.getTime() + nycOffset;

    return {
      colors: data,
      timestamp
    };
  } catch (error) {
    console.error("Error reading color data for specific date/time:", error);
    throw error;
  }
}

function getAllColorDataForDate(dateStr) {
  try {
    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error("Invalid date format. Expected YYYY-MM-DD");
    }

    // Check if date folder exists
    const dateFolderPath = path.join(dataDir, dateStr);
    if (!fs.existsSync(dateFolderPath)) {
      throw new Error(`No data available for date ${dateStr}`);
    }

    // Get all time files in this date folder
    const timeFiles = fs
      .readdirSync(dateFolderPath)
      .filter(
        (file) => file.endsWith(".json") && /^\d{2}-\d{2}\.json$/.test(file)
      )
      .sort((a, b) => a.localeCompare(b)); // Sort times ascending

    if (timeFiles.length === 0) {
      throw new Error(`No color data files found for date ${dateStr}`);
    }

    // Read all color data files for this date
    const allColorData = [];

    for (const timeFile of timeFiles) {
      const filePath = path.join(dateFolderPath, timeFile);
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

      // Extract time from filename (HH-MM.json -> HH:MM)
      const timeStr = timeFile.replace(".json", "").replace("-", ":");

      // Create timestamp from date and time (NYC timezone)
      const [year, month, day] = dateStr.split("-").map(Number);
      const [hour, minute] = timeStr.split(":").map(Number);

      // Create a date object representing this time in NYC
      const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

      // Adjust for NYC timezone offset
      const testDate = new Date(year, month - 1, day);
      const nycTestTime = testDate.toLocaleString("en-US", {
        timeZone: "America/New_York"
      });
      const utcTestTime = testDate.toLocaleString("en-US", {
        timeZone: "UTC"
      });
      const nycOffset =
        new Date(utcTestTime).getTime() - new Date(nycTestTime).getTime();

      const timestamp = utcDate.getTime() + nycOffset;

      allColorData.push({
        time: timeStr,
        colors: data,
        timestamp
      });
    }

    return allColorData;
  } catch (error) {
    console.error("Error reading all color data for date:", error);
    throw error;
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
    // Check for date/time parameters
    const { date, time } = req.query;

    let colorData;
    let isHistoricalData = false;
    let isDateOnlyRequest = false;

    if (date && time) {
      // Request for specific date/time
      try {
        colorData = getColorDataForDateTime(date, time);
        isHistoricalData = true;
      } catch (error) {
        return res.status(400).json({
          error: "Invalid date/time parameters",
          message: error.message,
          example: "Use format: ?date=2025-09-28&time=22:45"
        });
      }
    } else if (date && !time) {
      // Request for all data on a specific date
      try {
        const allDateData = getAllColorDataForDate(date);
        isHistoricalData = true;
        isDateOnlyRequest = true;

        // Format the response for date-only requests
        colorData = {
          date: date,
          intervals: allDateData,
          totalIntervals: allDateData.length
        };
      } catch (error) {
        return res.status(400).json({
          error: "Invalid date parameter",
          message: error.message,
          example:
            "Use format: ?date=2025-09-28 (for all intervals) or ?date=2025-09-28&time=22:45 (for specific time)"
        });
      }
    } else if (!date && time) {
      // Only time parameter provided (invalid)
      return res.status(400).json({
        error: "Date parameter required when specifying time",
        message:
          "When requesting historical data, the 'date' parameter is required. You can specify just date for all intervals, or both date and time for a specific interval.",
        example:
          "Use format: ?date=2025-09-28 (for all intervals) or ?date=2025-09-28&time=22:45 (for specific time)"
      });
    } else {
      // No parameters, get latest data
      const cachedData = await getCachedData();
      colorData = {
        colors: {
          west: cachedData.westColor,
          "north-west": cachedData.northWestColor,
          "north-east": cachedData.northEastColor,
          east: cachedData.eastColor
        },
        timestamp: cachedData.lastUpdated
      };
    }

    // Build response object
    let response;

    if (isDateOnlyRequest) {
      // Special response format for date-only requests
      response = {
        date: colorData.date,
        totalIntervals: colorData.totalIntervals,
        intervals: colorData.intervals.map((interval) => ({
          time: interval.time,
          colors: interval.colors,
          timestamp: interval.timestamp,
          formatted:
            new Date(interval.timestamp).toLocaleDateString("en-US", {
              timeZone: "America/New_York",
              year: "numeric",
              month: "long",
              day: "numeric"
            }) +
            " at " +
            new Date(interval.timestamp).toLocaleTimeString("en-US", {
              timeZone: "America/New_York",
              hour: "numeric",
              minute: "2-digit",
              hour12: true
            })
        })),
        metadata: {
          isHistoricalData,
          isDateOnlyRequest: true,
          source: config.source,
          updateInterval: {
            minutes: config.cache.updateIntervalMinutes,
            milliseconds: config.cache.updateIntervalMinutes * 60 * 1000
          }
        }
      };
    } else {
      // Standard response format for single time point requests
      const lastUpdatedFormatted =
        new Date(colorData.timestamp).toLocaleDateString("en-US", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "long",
          day: "numeric"
        }) +
        " at " +
        new Date(colorData.timestamp).toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          minute: "2-digit",
          hour12: true
        });

      response = {
        colors: colorData.colors,
        metadata: {
          isHistoricalData,
          lastUpdated: {
            timestamp: colorData.timestamp,
            formatted: lastUpdatedFormatted
          },
          source: config.source,
          updateInterval: {
            minutes: config.cache.updateIntervalMinutes,
            milliseconds: config.cache.updateIntervalMinutes * 60 * 1000
          }
        }
      };
    }

    // Only add cache age for current data (not historical)
    if (!isHistoricalData) {
      const cacheAge = Date.now() - colorData.timestamp;

      // Format cache age for display
      function formatCacheAge(ageMs) {
        const seconds = Math.floor(ageMs / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) return hours + "h " + (minutes % 60) + "m";
        if (minutes > 0) return minutes + "m " + (seconds % 60) + "s";
        return seconds + "s";
      }

      response.metadata.cacheAge = {
        milliseconds: cacheAge,
        formatted: formatCacheAge(cacheAge)
      };
    }

    // Only add next update info for current data (not historical)
    if (!isHistoricalData) {
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

      // Add next update info to metadata
      response.metadata.nextUpdate = {
        timestamp: nextUpdateTime,
        formatted: nextUpdateFormatted,
        timeRemaining: Math.max(0, timeToNextUpdate),
        timeRemainingFormatted: formatTimeRemaining(
          Math.max(0, timeToNextUpdate)
        )
      };
    }

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

app.get("/api/available-dates", async (req, res) => {
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

    // For each date folder, get the count of time intervals
    const availableDates = [];

    for (const dateFolder of dateFolders) {
      const dateFolderPath = path.join(dataDir, dateFolder);

      try {
        // Get all time files in this date folder
        const timeFiles = fs
          .readdirSync(dateFolderPath)
          .filter(
            (file) => file.endsWith(".json") && /^\d{2}-\d{2}\.json$/.test(file)
          );

        if (timeFiles.length > 0) {
          // Get first and last time for this date
          const sortedTimes = timeFiles
            .map((file) => file.replace(".json", "").replace("-", ":"))
            .sort();

          availableDates.push({
            date: dateFolder,
            intervalCount: timeFiles.length,
            firstTime: sortedTimes[0],
            lastTime: sortedTimes[sortedTimes.length - 1],
            formatted: new Date(dateFolder + "T00:00:00").toLocaleDateString(
              "en-US",
              {
                year: "numeric",
                month: "long",
                day: "numeric"
              }
            )
          });
        }
      } catch (error) {
        console.error(`Error reading date folder ${dateFolder}:`, error);
        // Skip this date folder if there's an error
        continue;
      }
    }

    res.json({
      availableDates,
      totalDates: availableDates.length,
      latestDate: availableDates.length > 0 ? availableDates[0].date : null,
      oldestDate:
        availableDates.length > 0
          ? availableDates[availableDates.length - 1].date
          : null
    });
  } catch (error) {
    console.error("Available dates endpoint error:", error);
    res.status(500).json({
      error: "Failed to get available dates",
      message: error.message
    });
  }
});

app.get("/api/recent", async (req, res) => {
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
      .sort((a, b) => b.localeCompare(a)) // Sort dates descending
      .slice(0, 30); // Take only the most recent 30 days

    const allIntervals = [];
    let totalIntervals = 0;

    // Load data for each of the recent dates
    for (const dateFolder of dateFolders) {
      const dateFolderPath = path.join(dataDir, dateFolder);

      try {
        // Get all time files in this date folder
        const timeFiles = fs
          .readdirSync(dateFolderPath)
          .filter(
            (file) => file.endsWith(".json") && /^\d{2}-\d{2}\.json$/.test(file)
          )
          .sort((a, b) => a.localeCompare(b)); // Sort times ascending

        // Read all color data files for this date
        for (const timeFile of timeFiles) {
          const filePath = path.join(dateFolderPath, timeFile);
          const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

          // Extract time from filename (HH-MM.json -> HH:MM)
          const timeStr = timeFile.replace(".json", "").replace("-", ":");

          // Create timestamp from date and time (NYC timezone)
          const [year, month, day] = dateFolder.split("-").map(Number);
          const [hour, minute] = timeStr.split(":").map(Number);

          // Create a date object representing this time in NYC
          const utcDate = new Date(
            Date.UTC(year, month - 1, day, hour, minute, 0)
          );

          // Adjust for NYC timezone offset
          const testDate = new Date(year, month - 1, day);
          const nycTestTime = testDate.toLocaleString("en-US", {
            timeZone: "America/New_York"
          });
          const utcTestTime = testDate.toLocaleString("en-US", {
            timeZone: "UTC"
          });
          const nycOffset =
            new Date(utcTestTime).getTime() - new Date(nycTestTime).getTime();

          const timestamp = utcDate.getTime() + nycOffset;

          allIntervals.push({
            date: dateFolder,
            time: timeStr,
            colors: data,
            timestamp
          });

          totalIntervals++;
        }
      } catch (error) {
        console.error(`Error reading date folder ${dateFolder}:`, error);
        continue;
      }
    }

    // Sort all intervals by timestamp (newest first)
    allIntervals.sort((a, b) => b.timestamp - a.timestamp);

    res.json({
      intervals: allIntervals,
      totalIntervals,
      dateRange: {
        from:
          dateFolders.length > 0 ? dateFolders[dateFolders.length - 1] : null,
        to: dateFolders.length > 0 ? dateFolders[0] : null
      },
      daysIncluded: dateFolders.length
    });
  } catch (error) {
    console.error("Recent data endpoint error:", error);
    res.status(500).json({
      error: "Failed to get recent data",
      message: error.message
    });
  }
});

app.get("/", async (req, res) => {
  try {
    // Serve the client HTML file
    const clientPath = path.join(process.cwd(), "index.html");
    res.sendFile(clientPath);
  } catch (error) {
    console.error("Client endpoint error:", error);
    res.status(500).json({
      error: "Failed to serve client",
      message: error.message
    });
  }
});

app.get("/history", async (req, res) => {
  try {
    // Serve the history view HTML file
    const historyPath = path.join(process.cwd(), "history.html");
    res.sendFile(historyPath);
  } catch (error) {
    console.error("History endpoint error:", error);
    res.status(500).json({
      error: "Failed to serve history view",
      message: error.message
    });
  }
});

// Debug endpoint to get the latest full frame image
app.get("/debug/image", async (req, res) => {
  try {
    console.log("Getting latest full frame image for debug...");
    const imageBuffer = await getFrameData();

    res.set({
      "Content-Type": "image/png",
      "Content-Length": imageBuffer.length
    });

    res.send(imageBuffer);
  } catch (error) {
    console.error("Debug latest image error:", error);
    res.status(500).json({
      error: "Failed to get latest image",
      message: error.message
    });
  }
});

// Debug endpoint to show full image with crop areas outlined
app.get("/debug/overlay", async (req, res) => {
  try {
    console.log("Getting full frame image with crop overlays...");

    // Get the full frame image first
    const imageBuffer = await getFrameData();

    // Get crop coordinates and dimensions from config
    const cropCoordinates = config.crops.coordinates;
    const cropWidth = config.crops.dimensions.width;
    const cropHeight = config.crops.dimensions.height;

    // Create overlay using ffmpeg with drawbox filter
    const overlayBuffer = await new Promise((resolve, reject) => {
      // Build the drawbox filter string for all crop areas
      const drawboxFilters = Object.entries(cropCoordinates)
        .map(([direction, coords]) => {
          return `drawbox=x=${coords.x}:y=${coords.y}:w=${cropWidth}:h=${cropHeight}:color=black@0.5:t=4`;
        })
        .join(",");

      const ffmpeg = spawn("ffmpeg", [
        "-y",
        "-f",
        "image2pipe",
        "-i",
        "pipe:0", // read from stdin
        "-vf",
        drawboxFilters, // apply all drawbox filters
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
        // console.error("ffmpeg overlay:", err.toString());
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`ffmpeg overlay exited with ${code}`));
        }
      });

      // Write the image buffer to ffmpeg's stdin
      ffmpeg.stdin.write(imageBuffer);
      ffmpeg.stdin.end();
    });

    res.set({
      "Content-Type": "image/png",
      "Content-Length": overlayBuffer.length
    });

    res.send(overlayBuffer);
  } catch (error) {
    console.error("Debug overlay error:", error);
    res.status(500).json({
      error: "Failed to create overlay image",
      message: error.message
    });
  }
});

// Debug endpoint to get cropped sections
app.get("/debug/crop/:direction", async (req, res) => {
  try {
    const direction = req.params.direction;
    const validDirections = ["west", "north-west", "north-east", "east"];

    if (!validDirections.includes(direction)) {
      return res.status(400).json({
        error: "Invalid direction",
        message: `Direction must be one of: ${validDirections.join(", ")}`
      });
    }

    console.log(`Getting cropped section for ${direction}...`);

    // Get the full frame image first
    const imageBuffer = await getFrameData();

    // Get crop coordinates from config
    const cropCoordinates = config.crops.coordinates[direction];

    // Create the cropped section
    const croppedBuffer = await getCroppedSection(
      imageBuffer,
      cropCoordinates.x,
      cropCoordinates.y
    );

    res.set({
      "Content-Type": "image/png",
      "Content-Length": croppedBuffer.length
    });

    res.send(croppedBuffer);
  } catch (error) {
    console.error(`Debug crop ${req.params.direction} error:`, error);
    res.status(500).json({
      error: "Failed to get cropped image",
      message: error.message
    });
  }
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
