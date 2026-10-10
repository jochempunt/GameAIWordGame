import express from "express";
import { networkInterfaces } from "node:os";
import { createServer } from "node:http";
import { Server, Socket } from "socket.io";
import { fileURLToPath } from "node:url";

import { Game, MIN_PLAYERS_TO_START } from "./game.js";
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

const ROOM_CODES = ["AAAA", "BBBB", "CCCC", "DDDD"];
const MAX_PLAYERS_PER_ROOM = 20;
const MAX_NAME_LENGTH = 20; // same as the maxlength of the name input
const HOST_GRACE_MS = 15_000; // a host who drops keeps the role this long
const DISCONNECT_PURGE_MS = 5 * 60_000; // disconnected players are removed after this long

const disconnectTimers = new Map<string, NodeJS.Timeout[]>();
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
    // an error thrown inside a socket handler would otherwise crash the whole server
    const on = (event: string, handler: (...args: any[]) => void): void => {
        socket.on(event, (...args: any[]) => {
            try {
                handler(...args);
            } catch (error) {
                console.error(`Error handling "${event}" from socket ${socket.id}:`, error);
            }
        });
    };

    on("getJoinAddress", (acknowledge) => {
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

    on("join", (roomId, name, acknowledge) => {
        joinPlayer(socket, roomId, name, safeAcknowledge(acknowledge));
    });

    on("rejoin", (token, acknowledge) => {
        rejoinPlayer(socket, token, safeAcknowledge(acknowledge));
    });

    on("startRound", () => {
        startRound(socket);
    });

    on("submitAnswer", (words, acknowledge) => {
        submitAnswer(socket, words, safeAcknowledge(acknowledge));
    });

    on("submitRanking", (rankedAnswerIds, acknowledge) => {
        submitRanking(
            socket,
            rankedAnswerIds,
            safeAcknowledge(acknowledge),
        );
    });

    on("readyForNextRound", (acknowledge) => {
        readyForNextRound(
            socket,
            safeAcknowledge(acknowledge),
        );
    });

    on("leaveGame", (acknowledge) => {
        leaveGame(
            socket,
            safeAcknowledge(acknowledge),
        );
    });

    on("kickPlayer", (playerId, acknowledge) => {
        kickPlayer(socket, playerId, safeAcknowledge(acknowledge));
    });

    on("transferHost", (playerId, acknowledge) => {
        transferHostFromSocket(socket, playerId, safeAcknowledge(acknowledge));
    });

    on("disconnect", () => {
        disconnectPlayer(socket);
    });
});


// ---- handlers ---- 

function joinPlayer(
    socket: Socket,
    roomId: unknown,
    name: unknown,
    acknowledge: (response: {
        ok: boolean;
        token?: string;
        error?: string;
    }) => void,
): void {
    // one socket controls at most one player
    if (getPlayerBySocket(socket)) {
        acknowledge({ ok: false, error: "You are already in a room" });
        return;
    }

    const room = typeof roomId === "string" ? rooms.get(roomId.toUpperCase()) : undefined;

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

    if (name.trim().length > MAX_NAME_LENGTH) {
        acknowledge({
            ok: false,
            error: "Name is too long",
        });

        return;
    }

    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
        acknowledge({ ok: false, error: "Room is full" });
        return;
    }

    const player: Player = {
        id: crypto.randomUUID(),
        token: crypto.randomUUID(),
        socketId: socket.id,
        name: name.trim(),
        connected: true,
    };

    room.players.set(player.id, player);
    if (room.game.state.phase === "lobby") {
        room.activePlayerIds.add(player.id);
    }
    attachSocket(socket, room, player);

    if (!room.hostPlayerId) {
        transferHost(room, player.id);
    }

    console.log(
        `Player joined: ${player.name} (${player.id}) in room ${room.id}`,
    );

    acknowledge({
        ok: true,
        token: player.token,
    });

    if (advanceRoomAfterMembershipChange(room)) {
        return;
    }

    pushState(room);
}
function rejoinPlayer(
    socket: Socket,
    token: unknown,
    acknowledge: (response: {
        ok: boolean;
        name?: string;
        error?: string;
    }) => void,
): void {
    const found = typeof token === "string" ? getPlayerByToken(token) : undefined;

    if (!found) {
        acknowledge({
            ok: false,
            error: "Player not found",
        });
        return;
    }

    const { player: foundPlayer, room: foundRoom } = found;
    const current = getPlayerBySocket(socket);

    if (current && current.player !== foundPlayer) {
        acknowledge({ ok: false, error: "You are already in a room" });
        return;
    }

    // the same player may still be open on an older socket (e.g. another tab)
    const previousSocket = io.sockets.sockets.get(foundPlayer.socketId);
    if (previousSocket && previousSocket.id !== socket.id) {
        detachSocket(previousSocket, foundRoom);
    }

    attachSocket(socket, foundRoom, foundPlayer);
    if (foundRoom.game.state.phase === "lobby") {
        foundRoom.activePlayerIds.add(foundPlayer.id);
    }

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
    const result = getPlayerBySocket(socket);

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
    const result = getPlayerBySocket(socket);

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

    if (
        !Array.isArray(rankedAnswerIds) ||
        !rankedAnswerIds.every(
            (answerId) => typeof answerId === "string",
        )
    ) {
        acknowledge({
            ok: false,
            error: "Invalid ranking",
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
    const result = getPlayerBySocket(socket);

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
    const result = getPlayerBySocket(socket);

    if (!result) {
        acknowledge({ ok: true });
        return;
    }

    const { player, room } = result;

    removePlayerFromRoom(room, player);

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
    const result = getPlayerBySocket(socket);
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
    removePlayerFromRoom(room, target);

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
    const result = getPlayerBySocket(socket);
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
    room: Room,
    player: Player,
): void {
    const wasHost = room.hostPlayerId === player.id;
    const socket = io.sockets.sockets.get(player.socketId);

    if (socket?.data.playerId === player.id) {
        detachSocket(socket, room);
    }
    clearDisconnectTimers(player.id);
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
        // a failed transfer to a specific player keeps the current host
        if (nextHostPlayerId) return undefined;

        room.hostPlayerId = null;
        console.log(`Room ${room.id} has no connected host candidate`);
        return undefined;
    }

    room.hostPlayerId = nextHost.id;
    console.log(`Player ${nextHost.name} is now the host of room ${room.id}`);
    return nextHost;
}
function disconnectPlayer(socket: Socket): void {
    const result = getPlayerBySocket(socket);
    if (!result) return;

    const { player, room } = result;

    player.connected = false;
    console.log(`Player disconnected: ${player.name} from room ${room.id}`);

    scheduleDisconnectTimers(room, player);

    if (advanceRoomAfterMembershipChange(room)) {
        return;
    }

    pushState(room);
}

// Phones drop the connection whenever the screen locks, so a disconnect is not final:
// the host keeps the role for a moment, and the player is only removed after a while.
function scheduleDisconnectTimers(room: Room, player: Player): void {
    clearDisconnectTimers(player.id);

    const stillGone = () => room.players.get(player.id) === player && !player.connected;

    const hostTimer = setTimeout(() => {
        try {
            if (!stillGone() || room.hostPlayerId !== player.id) return;

            console.log(`Host did not come back to room ${room.id}`);
            transferHost(room);
            pushState(room);
        } catch (error) {
            console.error(`Error transferring host in room ${room.id}:`, error);
        }
    }, HOST_GRACE_MS);

    const purgeTimer = setTimeout(() => {
        try {
            if (!stillGone()) return;

            console.log(`Removing disconnected player ${player.name} from room ${room.id}`);
            removePlayerFromRoom(room, player);

            if (advanceRoomAfterMembershipChange(room)) {
                return;
            }

            pushState(room);
        } catch (error) {
            console.error(`Error removing disconnected player from room ${room.id}:`, error);
        }
    }, DISCONNECT_PURGE_MS);

    disconnectTimers.set(player.id, [hostTimer, purgeTimer]);
}

function clearDisconnectTimers(playerId: string): void {
    for (const timer of disconnectTimers.get(playerId) ?? []) {
        clearTimeout(timer);
    }

    disconnectTimers.delete(playerId);
}

function startRound(socket: Socket): void {
    const result = getPlayerBySocket(socket);
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
    const phase = room.game.state.phase;

    if (phase === "lobby") {
        return false;
    }

    const connectedPlayers = getConnectedRoomPlayers(room);
    const roundPlayers = getActiveConnectedRoomPlayers(room);
    const everyoneReady =
        phase === "results" &&
        roundPlayers.length > 0 &&
        roundPlayers.every(player => room.readyPlayers.has(player.id));
    // in any phase: nobody who was playing this round is still here, so the
    // spectators waiting for the next round should not be stuck watching it
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

// socket.data remembers which player a socket controls
function attachSocket(socket: Socket, room: Room, player: Player): void {
    clearDisconnectTimers(player.id);
    player.socketId = socket.id;
    player.connected = true;
    socket.data.roomId = room.id;
    socket.data.playerId = player.id;
    socket.join(room.id);
}

function detachSocket(socket: Socket, room: Room): void {
    socket.data.roomId = undefined;
    socket.data.playerId = undefined;
    socket.leave(room.id);
}

function getPlayerBySocket(socket: Socket): { player: Player, room: Room } | undefined {
    const room = rooms.get(socket.data.roomId);
    const player = room?.players.get(socket.data.playerId);

    // a newer socket may have taken over this player since (rejoin from another tab)
    if (!room || !player || player.socketId !== socket.id) return undefined;
    return { player, room };
}

function getPlayerByToken(token: string): { player: Player, room: Room } | undefined {
    for (const room of rooms.values()) {
        for (const player of room.players.values()) {
            if (player.token === token) return { player, room };
        }
    }

    return undefined;
}
//  ---- Start server ----
httpServer.listen(PORT, HOST, () => {
    console.log(
        `Game server running on port ${PORT}`,
    );
});
