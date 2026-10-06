import express from "express";
import { networkInterfaces } from "node:os";
import { createServer } from "node:http";
import { Server, Socket } from "socket.io";
import { fileURLToPath } from "node:url";

import { Game } from "./game.js";
import type { Player } from "./types.js";
import { viewForHost, viewForPlayer } from "./views.js";


// ---- Setup ----

const PORT = 3000;
const HOST = "0.0.0.0";

const app = express();
const clientDist = fileURLToPath(
    new URL("../client/dist", import.meta.url),
);

app.use(express.static(clientDist));
const httpServer = createServer(app);
const io = new Server(httpServer);

const game = new Game();
const players = new Map<string, Player>();

const readyPlayers = new Set<string>();

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
            viewForPlayer(
            game,
            player,
            players.values(),
            readyPlayers,
        ),
        );
    }
}


// ---- Socket events ----


io.on("connection", (socket) => {
    socket.on("getJoinAddress", (acknowledge) => {
        const address = Object.values(networkInterfaces()).flat()
            .find(info => info?.family === "IPv4" && !info.internal)?.address;
        safeAcknowledge<{ address: string | null }>(acknowledge)({ address: address ?? null });
    });
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
    
    socket.on("submitRanking", (rankedAnswerIds, acknowledge) => {
        submitRanking(
            socket,
            rankedAnswerIds,
            safeAcknowledge(acknowledge),
        );
    });

    socket.on("readyForNextRound", (acknowledge) => {
    readyForNextRound(
        socket,
        safeAcknowledge(acknowledge),
        );
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
function submitRanking(
    socket: Socket,
    rankedAnswerIds: string[],
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
    
    const round = game.currentRound();
    
    if (!round || game.state.phase !== "ranking") {
        acknowledge({
            ok: false,
            error: "Ranking is not active",
        });
        
        return;
    }
    
    if (round.rankings.has(player.id)) {
        acknowledge({
            ok: false,
            error: "You have already submitted your ranking",
        });
        
        return;
    }
    
    const otherAnswers = round.answers.filter(
        answer => answer.playerId !== player.id,
    );
    if (rankedAnswerIds.length !== otherAnswers.length) {
        acknowledge({
            ok: false,
            error: "You must rank all answers",
        });
        
        return;
    }
    
    // Prevent duplicate answers.
    if (
        new Set(rankedAnswerIds).size !== rankedAnswerIds.length
    ) {
        acknowledge({
            ok: false,
            error: "Duplicate answer in ranking",
        });
        
        return;
    }
    
    const validAnswerIds = new Set(
        otherAnswers.map(answer => answer.id),
    );
    
    // Make sure every submitted ID belongs to another player's answer.
    if (
        rankedAnswerIds.some(
            answerId => !validAnswerIds.has(answerId),
        )
    ) {
        acknowledge({
            ok: false,
            error: "Invalid answer in ranking",
        });
        
        return;
    }
    
    // Save this player's ranking.
    round.rankings.set(
        player.id,
        rankedAnswerIds,
    );
    
    console.log(
        `Ranking submitted by ${player.name}:`,
        rankedAnswerIds,
    );
    
    acknowledge({
        ok: true,
    });
    
    tryFinishRanking();
    pushState();
}

function readyForNextRound(
    socket: Socket,
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

    if (game.state.phase !== "results") {
        acknowledge({
            ok: false,
            error: "Ready is not available",
        });

        return;
    }

    // Already ready
    if (readyPlayers.has(player.id)) {
        acknowledge({
            ok: true,
        });

        return;
    }

    readyPlayers.add(player.id);

    console.log(
        `Player ready for next round: ${player.name} (${readyPlayers.size}/${players.size})`,
    );

    acknowledge({
        ok: true,
    });

    const roundPlayers = getConnectedPlayers();

    const everyoneReady =
        roundPlayers.length > 0 &&
        roundPlayers.every(
            player => readyPlayers.has(player.id),
        );

    if (everyoneReady) {
        startNextRound();
        return;
    }

    pushState();
}

function startNextRound(): void {
    readyPlayers.clear();

    if (!game.startRound()) {
        console.error("Could not start next round");
        pushState();
        return;
    }

    const round = game.currentRound();

    if (!round) {
        console.error("Next round was started but no round exists");
        pushState();
        return;
    }

    console.log(`Round ${game.state.round} started`);
    console.log("Prompt:", round.prompt);
    console.log("Words:", round.words);

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
    const roundPlayers = [...players.values()];
    
    if (!round || roundPlayers.length === 0) {
        return;
    }
    
    const everyoneAnswered = roundPlayers.every(
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

function tryFinishRanking(): void {
    if (game.state.phase !== "ranking") {
        return;
    }
    
    const round = game.currentRound();
    
    if (!round) {
        return;
    }
    
    const roundPlayers = [...players.values()];
    
    if (roundPlayers.length === 0) {
        return;
    }

    const everyoneRanked = roundPlayers.every(
        player => round.rankings.has(player.id),
    );
    
    console.log(
        `Rankings: ${round.rankings.size}/${roundPlayers.length}`,
    );
    
    if (!everyoneRanked) {
        return;
    }
    
    console.log("Everyone ranked!");
    
    for (const [playerId, ranking] of round.rankings) {
        console.log(
            `Ranking from ${playerId}:`,
            ranking,
        );
    }
    
    game.calculateScores();

    for (const answer of round.answers) {
    const score = round.scores?.get(answer.id) ?? 0;

    const currentTotal =
        game.state.totals.get(answer.playerId) ?? 0;

    game.state.totals.set(
        answer.playerId,
        currentTotal + score,
        );
    }

    readyPlayers.clear();
    game.state.phase = "results";
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
