// http_server.js

const http = require("http");
const fs = require("fs").promises;
const path = require("path");

function startHttpServer({ port = 18080, baseDir }) {
  const deviceDir = path.join(baseDir, "status", "devices");
  const catalogPath = path.join(baseDir, "hmip_device_catalog.json");
  const changesPath = path.join(baseDir, "hmip_device_changes_last500.json");

  const server = http.createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(req.url);

      // ---------------- HEALTH ----------------
      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }

      // ---------------- LIST ALL DEVICES ----------------
      if (url === "/devices") {
        const files = await fs.readdir(deviceDir);
        const deviceIds = files
          .filter(f => f.endsWith(".json"))
          .map(f => f.replace(".json", ""));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(deviceIds, null, 2));
        return;
      }

      // ---------------- SINGLE DEVICE ----------------
      if (url.startsWith("/devices/")) {
        const id = url.replace("/devices/", "");
        const p = path.join(deviceDir, `${id}.json`);

        const data = await fs.readFile(p, "utf8");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(data);
        return;
      }

      // ---------------- CATALOG ----------------
      if (url === "/catalog") {
        const data = await fs.readFile(catalogPath, "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(data);
        return;
      }

      // ---------------- CHANGES ----------------
      if (url === "/changes") {
        const data = await fs.readFile(changesPath, "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(data);
        return;
      }

      // ---------------- HEATMAP JSON ----------------
      if (url === "/heatmap") {
        const files = await fs.readdir(deviceDir);
        const heatmap = [];

        for (const f of files) {
          if (!f.endsWith(".json")) continue;

          const id = f.replace(".json", "");
          const content = JSON.parse(
            await fs.readFile(path.join(deviceDir, f), "utf8")
          );

          heatmap.push({
            deviceId: id,
            last24h: content.changeCounter?.last24h || 0,
            last7d: content.changeCounter?.last7d || 0,
            last30d: content.changeCounter?.last30d || 0,
            total: content.changeCounter?.sinceStartTotal || 0
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(heatmap, null, 2));
        return;
      }

      // ---------------- HEATMAP UI ----------------
// ---------------- HEATMAP UI ----------------
if (url === "/heatmap-ui") {

  const html = `
  <html>
  <head>
    <title>HMIP Heatmap</title>
    <style>
      body {
        font-family: Arial;
        background:#111;
        color:#eee;
        margin:0;
        padding:0;
      }
      h1 {
        text-align:center;
        padding:20px;
        margin:0;
      }
      .legend {
        text-align:center;
        padding-bottom:10px;
      }
      .grid {
        display:grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap:10px;
        padding:20px;
      }
      .card {
        padding:15px;
        border-radius:10px;
        text-align:center;
        font-size:12px;
        transition: transform 0.2s, background 0.5s;
        color:#000;
        font-weight:bold;
      }
      .card:hover {
        transform: scale(1.05);
      }
    </style>
  </head>
  <body>
    <h1>HMIP Activity Heatmap (Last 24h)</h1>
    <div class="legend">
      Grün = wenig Aktivität | Rot = hohe Aktivität<br>
      Auto-Refresh: 5 Sekunden
    </div>
    <div class="grid" id="heatmapGrid"></div>

    <script>
      async function loadHeatmap() {
        const response = await fetch('/heatmap');
        const devices = await response.json();

        const grid = document.getElementById('heatmapGrid');
        grid.innerHTML = '';

        const max = Math.max(...devices.map(d => d.last24h), 1);

        devices.forEach(d => {
          const intensity = d.last24h / max;
          const red = Math.floor(255 * intensity);
          const green = Math.floor(255 * (1 - intensity));
          const color = \`rgb(\${red}, \${green}, 0)\`;

          const card = document.createElement('div');
          card.className = 'card';
          card.style.background = color;

          card.innerHTML = \`
            \${d.deviceId}<br><br>
            24h: \${d.last24h}<br>
            7d: \${d.last7d}<br>
            30d: \${d.last30d}<br>
            Total: \${d.total}
          \`;

          grid.appendChild(card);
        });
      }

      // initial load
      loadHeatmap();

      // auto refresh every 5 seconds
      setInterval(loadHeatmap, 5000);
    </script>

  </body>
  </html>
  `;

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
  return;
}


      // ---------------- 404 ----------------
      res.writeHead(404);
      res.end("Not Found");

    } catch (err) {
      res.writeHead(500);
      res.end("Server Error: " + err.message);
    }
  });

  server.listen(port, "0.0.0.0", ()=> {console.log(`HTTP Server listening on 0.0.0.0:${port}`)});

  console.log("======================================");
  console.log("HTTP Server gestartet!");
  console.log(`➡ Health:      http://localhost:${port}/health`);
  console.log(`➡ Devices:     http://localhost:${port}/devices`);
  console.log(`➡ Device:      http://localhost:${port}/devices/<id>`);
  console.log(`➡ Catalog:     http://localhost:${port}/catalog`);
  console.log(`➡ Heatmap:     http://localhost:${port}/heatmap`);
  console.log(`➡ Heatmap UI:  http://localhost:${port}/heatmap-ui`);
  console.log("======================================");


      selfTest(port);

}

function selfTest(port) {
  http.get(`http://127.0.0.1:${port}/health`, (res) => {
    console.log("SELFTEST /health status:", res.statusCode);
    res.resume();
  }).on("error", (e) => {
    console.log("SELFTEST /health error:", e.message);
  });
}


module.exports = { startHttpServer };
