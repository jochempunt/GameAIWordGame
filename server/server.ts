import express from "express";
import { createServer } from "node:http";
import { Server, Socket } from "socket.io";

import { Game } from "./game.js";
import type { Player, RoundState } from "./types.js";

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

const PORT = 3000;
const HOST = "0.0.0.0";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const game = new Game();
const players = new Map<string, Player>();

let hostSocketId: string | null = null;


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
        joinPlayer(socket, name, acknowledge);
    });

    socket.on("rejoin", (playerId, acknowledge) => {
        rejoinPlayer(socket, playerId, acknowledge);
    });

    socket.on("startRound", () => {
        startRound(socket);
    });

    socket.on("submitAnswer", (words, acknowledge) => {
        submitAnswer(socket, words, acknowledge);
    });

    socket.on("disconnect", () => {
        disconnectPlayer(socket);
    });
});


// ---- handlers ---- 
function registerHost(socket: Socket): void {
    if (hostSocketId && hostSocketId !== socket.id) {
        console.log("A host is already connected");
        return;
    }

    hostSocketId = socket.id;

    console.log("Host registered:", socket.id);
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
    if (game.state.phase !== "LOBBY") {
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

    if (hostSocketId) {
        io.to(hostSocketId).emit(
            "playerJoined",
            player,
        );
    }

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

    if (hostSocketId) {
        io.to(hostSocketId).emit(
            "answerReceived",
            {
                playerId: player.id,
                playerName: player.name,
                answer: answer.words,
            },
        );
    }

    acknowledge({
        ok: true,
    });

    tryStartVoting();
}

function disconnectPlayer(socket: Socket): void {
    if (socket.id === hostSocketId) {
        hostSocketId = null;
        console.log("Host disconnected");
    }

    const player = getPlayerBySocketId(socket.id);

    if (!player) {
        return;
    }

    player.connected = false;

    console.log(
        `Player disconnected: ${player.name}`,
    );

    if (hostSocketId) {
        io.to(hostSocketId).emit(
            "playerDisconnected",
            player.id,
        );
    }

    tryStartVoting();
}

function startRound(socket: Socket): void {
    if (socket.id !== hostSocketId) {
        return;
    }

    if (!game.startRound()) {
        return;
    }

    const round = getCurrentRound();

    if (!round) {
        return;
    }

    console.log(`Round ${game.state.round} started`);
    console.log("Prompt:", round.prompt);
    console.log("Words:", round.words);

    for (const player of getConnectedPlayers()) {
        io.to(player.socketId).emit("roundStarted", {
            round: game.state.round,
            prompt: round.prompt,
            words: round.words,
        });
    }

    if (hostSocketId) {
        io.to(hostSocketId).emit(
            "roundStartedForHost",
            {
                round: game.state.round,
                prompt: round.prompt,
            },
        );
    }
}


//  ---- Game flow ----


function tryStartVoting(): void {
    if (game.state.phase !== "PLAYING") {
        return;
    }

    const round = getCurrentRound();
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

    game.state.phase = "VOTING";

    console.log("Everyone answered");
    console.log("Starting voting");

    for (const player of connectedPlayers) {
        io.to(player.socketId).emit(
            "votingStarted",
            {
                playerId: player.id,
                answers: round.answers,
            },
        );
    }

    if (hostSocketId) {
        io.to(hostSocketId).emit(
            "votingStarted",
            {
                round,
            },
        );
    }
}

//  ---- Helpers ----

function getCurrentRound(): RoundState | undefined {
    return game.state.rounds.get(
        game.state.round,
    );
}

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