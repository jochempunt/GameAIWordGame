import express from "express";
import { createServer } from "node:http";
import { Server, Socket } from "socket.io";

import { Game } from "./game.js";
import type { Player } from "./types.js";
import { viewForHost, viewForPlayer } from "./views.js";


// ---- Setup ----

const PORT = 3000;
const HOST = "0.0.0.0";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const game = new Game();
const players = new Map<string, Player>();

let hostSocketId: string | null = null;

type Ack<T> = (response: T) => void;

function safeAcknowledge<T>(fn: unknown): Ack<T> {  // if something passes non function, we ignore it, so that the server doesnt crash
    return typeof fn === "function" ? (fn as Ack<T>) : () => undefined;
}


// ---- server state ----
function pushState(): void {
    if (hostSocketId) {
        io.to(hostSocketId).emit(
            "state",
            viewForHost(game, players.values()),
        );
    }
    
    for (const player of getConnectedPlayers()) {
        io.to(player.socketId).emit(
            "state",
            viewForPlayer(game, player),
        );
    }
}


// ---- Socket events ----


io.on("connection", (socket) => {
    console.log("\nNew connection");
    console.log("Socket ID:", socket.id);
    console.log("IP:", socket.handshake.address);
    console.log(
        "User-Agent:",
        socket.handshake.headers["user-agent"],
    );
    
    socket.on("registerHost", () => {
        registerHost(socket);
    });
    
    socket.on("join", (name, acknowledge) => {
        joinPlayer(socket, name,safeAcknowledge(acknowledge));
    });
    
    socket.on("rejoin", (playerId, acknowledge) => {
        rejoinPlayer(socket, playerId, safeAcknowledge(acknowledge));
    });
    
    socket.on("startRound", () => {
        startRound(socket);
    });
    
    socket.on("submitAnswer", (words, acknowledge) => {
        submitAnswer(socket, words, safeAcknowledge(acknowledge));
    });
    
    socket.on("disconnect", () => {
        disconnectPlayer(socket);
    });
});


// ---- handlers ---- 
function registerHost(socket: Socket): void {
    hostSocketId = socket.id;
    console.log("Host registered:", socket.id);
    pushState();
}

function joinPlayer(
    socket: Socket,
    name: string,
    acknowledge: (response: {
        ok: boolean;
        playerId?: string;
        error?: string;
    }) => void,
): void {
    if (game.state.phase !== "lobby") {
        acknowledge({
            ok: false,
            error: "Round already started",
        });
        
        return;
    }
    
    if (typeof name !== "string" || !name.trim()) {
        acknowledge({
            ok: false,
            error: "Name cannot be empty",
        });
        
        return;
    }
    
    const player: Player = {
        id: crypto.randomUUID(),
        socketId: socket.id,
        name: name.trim(),
        connected: true,
    };
    
    players.set(player.id, player);
    
    console.log(
        `Player joined: ${player.name} (${player.id})`,
    );
    
    pushState();
    
    acknowledge({
        ok: true,
        playerId: player.id,
    });
}

function rejoinPlayer(
    socket: Socket,
    playerId: string,
    acknowledge: (response: {
        ok: boolean;
        name?: string;
        error?: string;
    }) => void,
): void {
    const player = players.get(playerId);
    
    if (!player) {
        acknowledge({
            ok: false,
            error: "Player not found",
        });
        
        return;
    }
    
    player.socketId = socket.id;
    player.connected = true;
    
    console.log(
        `Player rejoined: ${player.name} (${player.id})`,
    );
    
    pushState();
    
    acknowledge({
        ok: true,
        name: player.name,
    });
}


function submitAnswer(
    socket: Socket,
    words: string[],
    acknowledge: (response: {
        ok: boolean;
        error?: string;
    }) => void,
): void {
    const player = getPlayerBySocketId(socket.id);
    
    if (!player) {
        acknowledge({
            ok: false,
            error: "Player not found",
        });
        
        return;
    }
    
    if (
        !Array.isArray(words) ||
        !words.every(
            (word) => typeof word === "string",
        )
    ) {
        acknowledge({
            ok: false,
            error: "Invalid answer",
        });
        
        return;
    }
    
    const answer = game.submitAnswer(
        player.id,
        words,
    );
    
    if (!answer) {
        acknowledge({
            ok: false,
            error: "Answer could not be submitted",
        });
        
        return;
    }
    
    console.log(
        `Answer submitted by ${player.name}:`,
        answer.words,
    );
    
    acknowledge({
        ok: true,
    });
    
    tryStartVoting();
    pushState();
}

function disconnectPlayer(socket: Socket): void {
    if (socket.id === hostSocketId) {
        hostSocketId = null;
        console.log("Host disconnected");
        return;
    }
    
    const player = getPlayerBySocketId(socket.id);
    
    if (!player) {
        return;
    }
    
    player.connected = false;
    console.log(`Player disconnected: ${player.name}`);
    
    pushState();
}
function startRound(socket: Socket): void {
    if (socket.id !== hostSocketId) {
        return;
    }
    
    if (!game.startRound()) {
        return;
    }
    
    const round = game.currentRound();
    
    if (!round) {
        return;
    }
    
    console.log(`Round ${game.state.round} started`);
    console.log("Prompt:", round.prompt);
    console.log("Words:", round.words);
    
    
    pushState();
}


//  ---- Game flow ----


function tryStartVoting(): void {
    if (game.state.phase !== "answering") {
        return;
    }
    
    const round = game.currentRound();
    const connectedPlayers = getConnectedPlayers();
    
    if (!round || connectedPlayers.length === 0) {
        return;
    }
    
    const everyoneAnswered = connectedPlayers.every(
        (player) =>
            round.answers.some(
            (answer) =>
                answer.playerId === player.id,
        ),
    );
    
    if (!everyoneAnswered) {
        return;
    }
    
    game.state.phase = "ranking";
    
    console.log("Everyone answered");
    console.log("Starting ranking phase");
}

//  ---- Helpers ----


function getConnectedPlayers(): Player[] {
    return [...players.values()].filter(
        (player) => player.connected,
    );
}

function getPlayerBySocketId(
    socketId: string,
): Player | undefined {
    return [...players.values()].find(
        (player) => player.socketId === socketId,
    );
}


//  ---- Start server ----
httpServer.listen(PORT, HOST, () => {
    console.log(
        `Game server running on port ${PORT}`,
    );
});