import http from "node:http";
import { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, "public");
const rooms = new Map();

const send = (ws, message) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
};

const makeCode = () => randomBytes(3).toString("hex").toUpperCase();

const getState = (room) => ({
  type: "state",
  room: room.code,
  players: [...room.players.values()].map(({ id, name, score, ready }) => ({ id, name, score, ready })),
  status: room.status,
  winner: room.winner
});

const broadcast = (room, message) => room.players.forEach((player) => send(player.ws, message));

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  const requestedPath = new URL(req.url, "http://localhost").pathname;
  const filePath = path.join(pub, requestedPath === "/" ? "index.html" : requestedPath);

  fs.readFile(filePath, (error, data) => {
    if (error) return res.writeHead(404).end("Not found");
    res.writeHead(200, {
      "Content-Type": filePath.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain"
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let me = null;
  let room = null;

  ws.on("error", (error) => console.error("WebSocket error:", error.message));

  ws.on("message", (buffer) => {
    let message;
    try {
      message = JSON.parse(buffer.toString());
    } catch {
      return send(ws, { type: "error", message: "Invalid message" });
    }

    if (message.type === "create") {
      let code;
      do code = makeCode(); while (rooms.has(code));
      room = { code, players: new Map(), status: "lobby", winner: null };
      rooms.set(code, room);
    } else if (message.type === "join") {
      room = rooms.get(String(message.code || "").trim().toUpperCase());
      if (!room) return send(ws, { type: "error", message: "Room not found" });
    }

    if ((message.type === "create" || message.type === "join") && room) {
      if (room.status !== "lobby") return send(ws, { type: "error", message: "Game already started" });

      me = {
        id: randomBytes(4).toString("hex"),
        name: String(message.name || "Player").slice(0, 20),
        score: 0,
        ready: false,
        ws
      };

      room.players.set(me.id, me);
      send(ws, { type: "connected", id: me.id, code: room.code });
      broadcast(room, getState(room));
      return;
    }

    if (!room || !me) return;

    if (message.type === "ready") {
      me.ready = !me.ready;
    } else if (message.type === "start" && room.players.size >= 2) {
      room.status = "playing";
      room.winner = null;
      room.players.forEach((player) => {
        player.score = 0;
        player.ready = false;
      });
    } else if (message.type === "tap" && room.status === "playing") {
      me.score += 1;
      if (me.score >= 10) {
        room.status = "finished";
        room.winner = me.id;
      }
    } else if (message.type === "again" && room.status === "finished") {
      room.status = "lobby";
      room.winner = null;
      room.players.forEach((player) => {
        player.score = 0;
        player.ready = false;
      });
    }

    broadcast(room, getState(room));
  });

  ws.on("close", () => {
    if (!room || !me) return;
    room.players.delete(me.id);
    if (room.players.size === 0) rooms.delete(room.code);
    else broadcast(room, getState(room));
  });
});

const port = Number(process.env.PORT) || 10000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Room Rush listening on 0.0.0.0:${port}`);
});
