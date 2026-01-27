import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: process.env.ORCH_PORT || 8080 });

wss.on("connection", (ws) => {
    ws.on("publish", (message) => {
        // todo
    })

    //// todooooo
});