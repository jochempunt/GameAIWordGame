import express from "express";
import { networkInterfaces } from "node:os";
import { createServer } from "node:http";
import { Server, Socket } from "socket.io";
import { fileURLToPath } from "node:url";

import { Game } from "./game.js";
import type { Player } from "./types.js";
import { viewForPlayer } from "./views.js";
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



const rooms = new Map<string, Room>();
const socketToRoom = new Map<string, string>();

const ROOM_CODES = ["AAAA", "BBBB", "CCCC", "DDDD"];
const MIN_PLAYERS_TO_START = 3;
for (const code of ROOM_CODES) {
    rooms.set(code, {
        id: code,
        game: new Game(),
        players: new Map<string, Player>(),
        readyPlayers: new Set<string>(),
        activePlayerIds: new Set<string>(),
        hostPlayerId: null,
    });
}

type Ack<T> = (response: T) => void;

function safeAcknowledge<T>(fn: unknown): Ack<T> {  // if something passes non function, we ignore it, so that the server doesnt crash
    return typeof fn === "function" ? (fn as Ack<T>) : () => undefined;
}


// ---- server state ----
function pushState(room: Room): void {

    for (const player of [...room.players.values()].filter(p => p.connected)) {
        io.to(player.socketId).emit(
            "state",
            viewForPlayer(
                room.game,
                player,
                room.players.values(),
                room.readyPlayers,
                room.activePlayerIds,
                room.hostPlayerId,
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

    socket.on("leaveGame", (acknowledge) => {
        leaveGame(
            socket,
            safeAcknowledge(acknowledge),
        );
    });

    socket.on("kickPlayer", (playerId, acknowledge) => {
        kickPlayer(socket, playerId, safeAcknowledge(acknowledge));
    });

    socket.on("transferHost", (playerId, acknowledge) => {
        transferHostFromSocket(socket, playerId, safeAcknowledge(acknowledge));
    });

    socket.on("disconnect", () => {
        disconnectPlayer(socket);
    });
});


// ---- handlers ---- 

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
    if (room.game.state.phase === "lobby") {
        room.activePlayerIds.add(player.id);
    }
    socketToRoom.set(socket.id, room.id);
    socket.join(room.id);

    if (!room.hostPlayerId) {
        transferHost(room, player.id);
    }

    console.log(
        `Player joined: ${player.name} (${player.id}) in room ${room.id}`,
    );

    acknowledge({
        ok: true,
        playerId: player.id,
    });

    if (advanceRoomAfterMembershipChange(room)) {
        return;
    }

    pushState(room);
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
    if (foundRoom.game.state.phase === "lobby") {
        foundRoom.activePlayerIds.add(foundPlayer.id);
    }
    socketToRoom.set(socket.id, foundRoom.id);
    socket.join(foundRoom.id);

    if (!foundRoom.hostPlayerId) {
        transferHost(foundRoom, foundPlayer.id);
    }

    console.log(`Player rejoined: ${foundPlayer.name} (${foundPlayer.id}) in room ${foundRoom.id}`);

    acknowledge({
        ok: true,
        name: foundPlayer.name,
    });

    if (advanceRoomAfterMembershipChange(foundRoom)) {
        return;
    }

    pushState(foundRoom);
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

    if (!room.activePlayerIds.has(player.id)) {
        acknowledge({
            ok: false,
            error: "Spectators cannot submit answers",
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

    if (advanceRoomAfterMembershipChange(room)) {
        return;
    }

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

    if (!room.activePlayerIds.has(player.id)) {
        acknowledge({
            ok: false,
            error: "Spectators cannot submit rankings",
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

    if (!room.activePlayerIds.has(player.id)) {
        acknowledge({
            ok: false,
            error: "Spectators join when the room returns to the lobby",
        });

        return;
    }

    if (room.readyPlayers.has(player.id)) {
        acknowledge({ ok: true });
        return;
    }

    room.readyPlayers.add(player.id);

    console.log(
        `Player returned to lobby: ${player.name} (${room.readyPlayers.size}/${getActiveConnectedRoomPlayers(room).length})`,
    );

    acknowledge({ ok: true });

    if (tryReturnToLobbyIfReady(room)) {
        return;
    }

    pushState(room);
}
function leaveGame(
    socket: Socket,
    acknowledge: (response: {
        ok: boolean;
        error?: string;
    }) => void,
): void {
    const result = getPlayerBySocketId(socket.id);

    if (!result) {
        acknowledge({ ok: true });
        return;
    }

    const { player, room } = result;

    removePlayerFromRoom(socket, room, player);

    console.log(`Player left room ${room.id}: ${player.name}`);

    acknowledge({ ok: true });

    if (advanceRoomAfterMembershipChange(room)) {
        return;
    }

    pushState(room);
}

function kickPlayer(
    socket: Socket,
    targetPlayerId: string,
    acknowledge: (response: { ok: boolean; error?: string }) => void,
): void {
    const result = getPlayerBySocketId(socket.id);
    if (!result) {
        acknowledge({ ok: false, error: "Player not found" });
        return;
    }

    const { player, room } = result;
    if (player.id !== room.hostPlayerId) {
        acknowledge({ ok: false, error: "Only the host can kick players" });
        return;
    }

    const target = room.players.get(targetPlayerId);
    if (!target) {
        acknowledge({ ok: false, error: "Player not found" });
        return;
    }

    io.to(target.socketId).emit("kicked");
    removePlayerFromRoom({ id: target.socketId, leave: (roomId: string) => io.sockets.sockets.get(target.socketId)?.leave(roomId) } as Socket, room, target);

    acknowledge({ ok: true });

    if (advanceRoomAfterMembershipChange(room)) {
        return;
    }

    pushState(room);
}

function transferHostFromSocket(
    socket: Socket,
    targetPlayerId: string,
    acknowledge: (response: { ok: boolean; error?: string }) => void,
): void {
    const result = getPlayerBySocketId(socket.id);
    if (!result) {
        acknowledge({ ok: false, error: "Player not found" });
        return;
    }

    const { player, room } = result;
    if (player.id !== room.hostPlayerId) {
        acknowledge({ ok: false, error: "Only the host can transfer host" });
        return;
    }

    const nextHost = transferHost(room, targetPlayerId);
    if (!nextHost) {
        acknowledge({ ok: false, error: "Could not transfer host" });
        return;
    }

    acknowledge({ ok: true });
    pushState(room);
}
function removePlayerFromRoom(
    socket: Socket,
    room: Room,
    player: Player,
): void {
    const wasHost = room.hostPlayerId === player.id;

    socketToRoom.delete(socket.id);
    socket.leave(room.id);
    room.readyPlayers.delete(player.id);
    room.activePlayerIds.delete(player.id);
    room.players.delete(player.id);

    if (room.players.size === 0) {
        room.game = new Game();
        room.readyPlayers.clear();
        room.activePlayerIds.clear();
        room.hostPlayerId = null;
        return;
    }

    if (wasHost) {
        transferHost(room);
    }
}

function transferHost(
    room: Room,
    nextHostPlayerId?: string,
): Player | undefined {
    const nextHost = nextHostPlayerId
        ? room.players.get(nextHostPlayerId)
        : [...room.players.values()].find(candidate => candidate.connected);

    if (!nextHost || !nextHost.connected) {
        room.hostPlayerId = null;
        console.log(`Room ${room.id} has no connected host candidate`);
        return undefined;
    }

    room.hostPlayerId = nextHost.id;
    console.log(`Player ${nextHost.name} is now the host of room ${room.id}`);
    return nextHost;
}
function disconnectPlayer(socket: Socket): void {
    const result = getPlayerBySocketId(socket.id);
    if (!result) return;

    const { player, room } = result;

    player.connected = false;
    socketToRoom.delete(socket.id);
    console.log(`Player disconnected: ${player.name} from room ${room.id}`);

    if (player.id === room.hostPlayerId) {
        console.log(`Host disconnected from room ${room.id}`);
        transferHost(room);
    }

    if (advanceRoomAfterMembershipChange(room)) {
        return;
    }

    pushState(room);
}

function startRound(socket: Socket): void {
    const result = getPlayerBySocketId(socket.id);
    if (!result) return;

    const { player, room } = result;
    const game = room.game;

    if (player.id !== room.hostPlayerId) return;
    if (game.state.phase !== "lobby") return;

    setActivePlayersForLobby(room);
    if (room.activePlayerIds.size < MIN_PLAYERS_TO_START) return;

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
    const roundPlayers = getActiveConnectedRoomPlayers(room);

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

    const roundPlayers = getActiveConnectedRoomPlayers(room);

    if (roundPlayers.length === 0) return;

    const everyoneRanked = roundPlayers.every(
        player =>
            round.rankings.has(player.id) ||
            !round.answers.some(answer => answer.playerId !== player.id),
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
function advanceRoomAfterMembershipChange(room: Room): boolean {
    tryStartVoting(room);
    tryFinishRanking(room);

    return tryReturnToLobbyIfReady(room);
}

function tryReturnToLobbyIfReady(room: Room): boolean {
    if (room.game.state.phase !== "results") {
        return false;
    }

    const connectedPlayers = getConnectedRoomPlayers(room);
    const roundPlayers = getActiveConnectedRoomPlayers(room);
    const everyoneReady =
        roundPlayers.length > 0 &&
        roundPlayers.every(player => room.readyPlayers.has(player.id));
    const noActivePlayersConnected =
        roundPlayers.length === 0 && connectedPlayers.length > 0;

    if (!everyoneReady && !noActivePlayersConnected) {
        return false;
    }

    room.game.state.phase = "lobby";
    setActivePlayersForLobby(room);

    console.log(`Room ${room.id} returned to lobby`);

    pushState(room);
    return true;
}

function setActivePlayersForLobby(room: Room): void {
    room.readyPlayers.clear();
    room.activePlayerIds = new Set(
        getConnectedRoomPlayers(room).map(player => player.id),
    );
}

function getActiveConnectedRoomPlayers(room: Room): Player[] {
    return getConnectedRoomPlayers(room).filter(player => room.activePlayerIds.has(player.id));
}

function getConnectedRoomPlayers(room: Room): Player[] {
    return [...room.players.values()].filter(player => player.connected);
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
