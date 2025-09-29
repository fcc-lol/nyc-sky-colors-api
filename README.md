# NYC Sky Colors

Identifier: nyc-sky-colors

Created: Sun Sep 28 19:17:37 UTC 2025

## Available Routes

### Viewer

- `/` - Front-end web interface showing data from the API

### API Endpoints

- `/api` - JSON API returning current sky colors and metadata
- `/update-cache` - Trigger manual cache update (starts background process)

### Debug Endpoints

- `/debug/image` - View the latest full frame image from the stream
- `/debug/overlay` - View the full image with crop areas outlined (transparent black borders)
- `/debug/crop/west` - View the west crop section
- `/debug/crop/north-west` - View the north-west crop section
- `/debug/crop/north-east` - View the north-east crop section
- `/debug/crop/east` - View the east crop section
