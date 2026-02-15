const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const { features } = require("process");
const fs = require("fs").promises;
const { createHmipDeviceLogger } = require("./device_logger");
const { startHttpServer } = require("./http_server");
const path = require("path");


async function start(pluginId, host, authtokenFile) {
  const authtoken = (await fs.readFile(authtokenFile, "utf8")).trim();
  const logger = createHmipDeviceLogger({ dir: __dirname, maxEntries: 500 });
  await logger.init();
  const PORT = 18080;
  startHttpServer({
    port: PORT,
    baseDir: __dirname
  });

  const webSocket = new WebSocket("wss://" + host + ":9001", {
    rejectUnauthorized: false,
    headers: {
      authtoken,
      "plugin-id": pluginId,
      "hmip-system-events": "true"
    },
  });

  function sendPluginReady(messageId) {
    const message = {
      id: messageId,
      pluginId,
      type: "PLUGIN_STATE_RESPONSE",
      body: { pluginReadinessStatus: "READY" },
    };
    webSocket.send(JSON.stringify(message));
    console.log("Sent message:", JSON.stringify(message, null, 2));
  }

   function GetSystemState(messageId){
    const message = {
      id: messageId,
      pluginId,
      type: "HMIP_SYSTEM_REQUEST",
      body: { 
        path: "/hmip/home/getSystemState", 
        body:{} 
      }
    };
    webSocket.send(JSON.stringify(message));
    console.log("Sent message:", JSON.stringify(message, null, 2));
   }

  webSocket.on("open", () => {
    console.log("Connected to WebSocket");
    sendPluginReady(uuidv4());
    GetSystemState(uuidv4());
  });

webSocket.on("message", async (data) => {
  const message = JSON.parse(data);

  if (message.type === "PLUGIN_STATE_REQUEST") {
    sendPluginReady(message.id);
    return;
  }

  if (
    message.type === "HMIP_SYSTEM_RESPONSE" //&&
  ) {
    console.log("✅ getSystemState response received");
    await logger.handleSystemStateResponse(message);
    console.log("✅ systemState_full.json + hmip_device_status.json initialisiert");
    return;
  }

  // laufende Änderungen
  if (message.type === "HMIP_SYSTEM_EVENT") {
    await logger.handleHmipSystemEvent(message);
    return;
  }

});

  webSocket.on("error", (err) => {
    console.error("WebSocket error:", err.code, err.message || err);
  });


}



// parse command line parameters
const args = process.argv.slice(2);
const pluginId = args[0];
const host = args[1];
const authtokenFile = args[2];

if (!pluginId || !host || !authtokenFile ) {
  console.error("Usage: node plugin.js <pluginId> <host> <authtokenFile>");
  process.exit(1);
}

start(pluginId, host, authtokenFile);
