import express from "express";
import { networkInterfaces } from "node:os";
import { createServer } from "node:http";
import { Server, Socket } from "socket.io";
import { fileURLToPath } from "node:url";

import { Game } from "./game.js";
import type { Player } from "./types.js";
import { viewForHost, viewForPlayer } from "./views.js";
import type { Room } from "./types.js";


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


// old game code, remove if irrelevant -----------------------------------------------------------------------------------------------
// const game = new Game();
// const players = new Map<string, Player>();

// const readyPlayers = new Set<string>();

// let hostSocketId: string | null = null;

const rooms = new Map<string, Room>();
const socketToRoom = new Map<string, string>();

const ROOM_CODES = ["AAAA", "BBBB", "CCCC", "DDDD"];
for (const code of ROOM_CODES) {
    rooms.set(code, {
        id: code,
        game: new Game(),
        players: new Map<string, Player>(),
        readyPlayers: new Set<string>(),
        hostSocketId: null,
    });
}

type Ack<T> = (response: T) => void;

function safeAcknowledge<T>(fn: unknown): Ack<T> {  // if something passes non function, we ignore it, so that the server doesnt crash
    return typeof fn === "function" ? (fn as Ack<T>) : () => undefined;
}


// ---- server state ----
function pushState(room: Room): void {
    if (room.hostSocketId) {
        io.to(room.hostSocketId).emit(
            "state",
            viewForHost(room.game, room.players.values()),
        );
    }

    for (const player of [...room.players.values()].filter(p => p.connected)) {
        io.to(player.socketId).emit(
            "state",
            viewForPlayer(
                room.game,
                player,
                room.players.values(),
                room.readyPlayers,
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

    // socket.on("registerHost", () => {
    //     registerHost(socket);
    // });

    socket.on("join", (roomId, name, acknowledge) => {
        joinPlayer(socket, roomId, name, safeAcknowledge(acknowledge));
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
// old code
// function registerHost(socket: Socket): void {
//     hostSocketId = socket.id;
//     console.log("Host registered:", socket.id);
//     pushState();
// }

function joinPlayer(
    socket: Socket,
    roomId: String,
    name: string,
    acknowledge: (response: {
        ok: boolean;
        playerId?: string;
        error?: string;
    }) => void,
): void {
    const room = rooms.get(roomId.toUpperCase());

    if (!room) {
        acknowledge({ ok: false, error: "Room not found" });
        return;
    }

    if (room.game.state.phase !== "lobby") {
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

    room.players.set(player.id, player);
    socketToRoom.set(socket.id, room.id);
    socket.join(room.id);

    if (!room.hostSocketId) {
        room.hostSocketId = socket.id;
        console.log(`Player ${player.name} is now the host of ${room.id}`);
    }

    console.log(
        `Player joined: ${player.name} (${player.id}) in room ${room.id}`,
    );

    pushState(room);

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
    let foundRoom: Room | undefined;
    let foundPlayer: Player | undefined;

    for (const room of rooms.values()) {
        if (room.players.has(playerId)) {
            foundRoom = room;
            foundPlayer = room.players.get(playerId);
            break;
        }
    }
    if (!foundPlayer || !foundRoom) {
        acknowledge({
            ok: false,
            error: "Player not found",
        });
        return;
    }

    foundPlayer.socketId = socket.id;
    foundPlayer.connected = true;
    socketToRoom.set(socket.id, foundRoom.id);
    socket.join(foundRoom.id);

    console.log(`Player rejoined: ${foundPlayer.name} (${foundPlayer.id}) in room ${foundRoom.id}`);

    pushState(foundRoom);

    acknowledge({
        ok: true,
        name: foundPlayer.name,
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
    const result = getPlayerBySocketId(socket.id);

    if (!result) {
        acknowledge({
            ok: false,
            error: "Player not found",
        });

        return;
    }

    const { player, room } = result;
    const game = room.game;

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

    tryStartVoting(room);
    pushState(room);
}
function submitRanking(
    socket: Socket,
    rankedAnswerIds: string[],
    acknowledge: (response: {
        ok: boolean;
        error?: string;
    }) => void,
): void {
    const result = getPlayerBySocketId(socket.id);

    if (!result) {
        acknowledge({
            ok: false,
            error: "Player not found",
        });

        return;
    }

    const { player, room } = result;
    const game = room.game;

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

    tryFinishRanking(room);
    pushState(room);
}

function readyForNextRound(
    socket: Socket,
    acknowledge: (response: {
        ok: boolean;
        error?: string;
    }) => void,
): void {
    const result = getPlayerBySocketId(socket.id);

    if (!result) {
        acknowledge({
            ok: false,
            error: "Player not found",
        });

        return;
    }

    const { player, room } = result;
    const game = room.game;

    if (game.state.phase !== "results") {
        acknowledge({
            ok: false,
            error: "Ready is not available",
        });

        return;
    }

    // Already ready
    if (room.readyPlayers.has(player.id)) {
        acknowledge({
            ok: true,
        });

        return;
    }

    room.readyPlayers.add(player.id);

    console.log(
        `Player ready for next round: ${player.name} (${room.readyPlayers.size}/${room.players.size})`,
    );

    acknowledge({
        ok: true,
    });

    const roundPlayers = [...room.players.values()].filter((p) => p.connected);

    const everyoneReady =
        roundPlayers.length > 0 &&
        roundPlayers.every(
            (player) => room.readyPlayers.has(player.id),
        );

    if (everyoneReady) {
        startNextRound(room);
        return;
    }

    pushState(room);
}

function startNextRound(room: Room): void {
    room.readyPlayers.clear();

    if (!room.game.startRound()) {
        console.error("Could not start next round");
        pushState(room);
        return;
    }

    const round = room.game.currentRound();

    if (!round) {
        console.error("Next round was started but no round exists");
        pushState(room);
        return;
    }

    console.log(`Round ${room.game.state.round} started`);
    console.log("Prompt:", round.prompt);
    console.log("Words:", round.words);

    pushState(room);
}
function disconnectPlayer(socket: Socket): void {
    const result = getPlayerBySocketId(socket.id);
    if (!result) return;

    const { player, room } = result;

    player.connected = false;
    console.log(`Player disconnected: ${player.name} from room ${room.id}`);

    //host disconnected logic
    if (socket.id == room.hostSocketId) {
        console.log(`Host disconnected from room ${room.id}`);
        room.hostSocketId = null;

        const nextHost = [...room.players.values()].find(p => p.connected);
        if (nextHost) {
            room.hostSocketId = nextHost.socketId;
            console.log(`Player ${nextHost.name} is the new host of room ${room.id}`);
        }
    }

    pushState(room);
}

function startRound(socket: Socket): void {
    const result = getPlayerBySocketId(socket.id);
    if (!result) return;

    const { room } = result;
    const game = room.game;

    if (socket.id !== room.hostSocketId) return;

    if (!game.startRound()) return;

    const round = game.currentRound();

    if (!round) return;

    console.log(`Room ${room.id} - round ${game.state.round} started`);
    console.log("Prompt:", round.prompt);
    console.log("Words:", round.words);


    pushState(room);
}


//  ---- Game flow ----


function tryStartVoting(room: Room): void {
    if (room.game.state.phase !== "answering") return;

    const round = room.game.currentRound();
    const roundPlayers = [...room.players.values()];

    if (!round || roundPlayers.length === 0) return;

    const everyoneAnswered = roundPlayers.every(
        (player) =>
            round.answers.some(
                (answer) =>
                    answer.playerId === player.id,
            ),
    );

    if (!everyoneAnswered) return;

    room.game.state.phase = "ranking";

    console.log("Everyone answered");
    console.log("Starting ranking phase");
}

function tryFinishRanking(room: Room): void {
    if (room.game.state.phase !== "ranking") return;

    const round = room.game.currentRound();

    if (!round) return;

    const roundPlayers = [...room.players.values()];

    if (roundPlayers.length === 0) return;

    const everyoneRanked = roundPlayers.every(
        player => round.rankings.has(player.id),
    );

    console.log(
        `Rankings: ${round.rankings.size}/${roundPlayers.length}`,
    );

    if (!everyoneRanked) return;

    console.log("Everyone ranked!");

    for (const [playerId, ranking] of round.rankings) {
        console.log(
            `Ranking from ${playerId}:`,
            ranking,
        );
    }

    room.game.calculateScores();

    for (const answer of round.answers) {
        const score = round.scores?.get(answer.id) ?? 0;

        const currentTotal =
            room.game.state.totals.get(answer.playerId) ?? 0;

        room.game.state.totals.set(
            answer.playerId,
            currentTotal + score,
        );
    }

    room.readyPlayers.clear();
    room.game.state.phase = "results";
}
//  ---- Helpers ----


// function getConnectedPlayers(): Player[] {
//     return [...players.values()].filter(
//         (player) => player.connected,
//     );
// }

// function getPlayerBySocketId(
//     socketId: string,
// ): Player | undefined {
//     return [...players.values()].find(
//         (player) => player.socketId === socketId,
//     );
// }

function getPlayerBySocketId(socketId: string): { player: Player, room: Room } | undefined {
    const roomId = socketToRoom.get(socketId);
    if (!roomId) return undefined;

    const room = rooms.get(roomId);
    if (!room) return undefined;

    const player = room.players.get(socketId);

    const foundPlayer = [...room.players.values()].find((p) => p.socketId === socketId);
    if (!foundPlayer) return undefined;
    return { player: foundPlayer, room };
}
//  ---- Start server ----
httpServer.listen(PORT, HOST, () => {
    console.log(
        `Game server running on port ${PORT}`,
    );
});
