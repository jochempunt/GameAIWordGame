import express from "express";
import { networkInterfaces } from "node:os";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { Server, Socket } from "socket.io";
import { fileURLToPath } from "node:url";

import { Game, MIN_PLAYERS_TO_START } from "./game.js";
import type { Player } from "./types.js";
import { viewForPlayer } from "./views.js";
import type { Room, RoomSummary } from "./types.js";
import { connectToDatabase, disconnectFromDatabase } from "./database/db.js";
import { saveGame, flushGameSaves } from "./database/gameRepository.js";
import { generatePlayerName } from "./playerNames.js";
import { hasConsented, recordConsent } from "./database/participantRepository.js";


// ---- Setup ----

const PORT = 3000;
// Docker sets 0.0.0.0 (see Dockerfile) so the tunnel container can reach the game.
// Everywhere else only this machine can; phones in development go through the Vite dev server.
const HOST = process.env.LISTEN_HOST ?? "127.0.0.1";

const app = express();
const clientDist = fileURLToPath(
    new URL("../client/dist", import.meta.url),
);

app.use(express.static(clientDist));
const httpServer = createServer(app);
const io = new Server(httpServer);



const rooms = new Map<string, Room>();

const ROOM_COUNT = 20;
const ROOM_CODES = Array.from(
    { length: ROOM_COUNT },
    (_, index) => String.fromCharCode("A".charCodeAt(0) + index).repeat(4),
);
const MAX_PLAYERS_PER_ROOM = 20;
const MAX_NAME_LENGTH = 20; // same as the maxlength of the name input
const DISCONNECT_GRACE_MS = 15_000; // Keep the host role and wait for missing round actions this long.
const DISCONNECT_PURGE_MS = 5 * 60_000; // disconnected players are removed after this long

let shuttingDown = false;
const disconnectTimers = new Map<string, NodeJS.Timeout[]>();
for (const code of ROOM_CODES) {
    rooms.set(code, {
        id: code,
        game: new Game(),
        players: new Map<string, Player>(),
        readyPlayers: new Set<string>(),
        activePlayerIds: new Set<string>(),
        hostPlayerId: null,
        locked: false,
    });
}

type Ack<T> = (response: T) => void;

function safeAcknowledge<T>(fn: unknown): Ack<T> {  // if something passes non function, we ignore it, so that the server doesnt crash
    return typeof fn === "function" ? (fn as Ack<T>) : () => undefined;
}

function validSessionToken(token: unknown): string | undefined {
    return typeof token === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)
        ? token
        : undefined;
}

function playerIdForToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function hasSocketConsent(socket: Socket, token: unknown): boolean {
    const validToken = validSessionToken(token);
    return validToken !== undefined
        && socket.data.consentedPlayerId === playerIdForToken(validToken);
}

async function checkConsent(
    socket: Socket,
    token: unknown,
    acknowledge: Ack<{ ok: boolean; consented: boolean; participantId?: string; error?: string }>,
): Promise<void> {
    const validToken = validSessionToken(token);
    if (!validToken) {
        acknowledge({ ok: false, consented: false, error: "Invalid participant session" });
        return;
    }

    try {
        const playerId = playerIdForToken(validToken);
        const consented = await hasConsented(playerId);
        if (!consented) {
            acknowledge({ ok: true, consented });
            return;
        }

        socket.data.consentedPlayerId = playerId;
        // the stored id, so participants can quote it when asking to withdraw
        acknowledge({ ok: true, consented, participantId: playerId });
    } catch (error) {
        console.error("Could not check participant consent:", error);
        acknowledge({ ok: false, consented: false, error: "Could not verify consent" });
    }
}

async function giveConsent(
    socket: Socket,
    token: unknown,
    acknowledge: Ack<{ ok: boolean; participantId?: string; error?: string }>,
): Promise<void> {
    const validToken = validSessionToken(token);
    if (!validToken) {
        acknowledge({ ok: false, error: "Invalid participant session" });
        return;
    }

    try {
        const playerId = playerIdForToken(validToken);
        await recordConsent(playerId);
        socket.data.consentedPlayerId = playerId;
        acknowledge({ ok: true, participantId: playerId });
    } catch (error) {
        console.error("Could not record participant consent:", error);
        acknowledge({ ok: false, error: "Could not record consent" });
    }
}


// ---- server state ----
function roomSummaries(): RoomSummary[] {
    return [...rooms.values()].map(room => ({
        id: room.id,
        playerCount: room.players.size,
        capacity: MAX_PLAYERS_PER_ROOM,
        phase: room.game.state.phase,
        locked: room.locked,
    }));
}

// Commit after game-flow transitions so the snapshot includes phase changes and scores.
function commitRoomState(room: Room): void {
    persistRoomGame(room);
    pushState(room);
}

function persistRoomGame(room: Room): void {
    void saveGame(room.game, room.id).catch((error) => {
        console.error(`Could not save game in room ${room.id}:`, error);
    });
}

function pushRoomSummaries(): void {
    for (const socket of io.sockets.sockets.values()) {
        if (socket.data.consentedPlayerId) socket.emit("rooms", roomSummaries());
    }
}

function pushState(room: Room): void {
    pushRoomSummaries();

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
                room.locked,
            ),
        );
    }
}


// ---- Socket events ----


io.on("connection", (socket) => {
    // an error thrown inside a socket handler would otherwise crash the whole server
    const on = (event: string, handler: (...args: any[]) => void): void => {
        socket.on(event, (...args: any[]) => {
            if (shuttingDown) return;
            try {
                handler(...args);
            } catch (error) {
                console.error(`Error handling "${event}" from socket ${socket.id}:`, error);
            }
        });
    };

    on("checkConsent", (token, acknowledge) => {
        void checkConsent(socket, token, safeAcknowledge(acknowledge));
    });

    on("giveConsent", (token, acknowledge) => {
        void giveConsent(socket, token, safeAcknowledge(acknowledge));
    });

    on("getRooms", () => {
        if (socket.data.consentedPlayerId) socket.emit("rooms", roomSummaries());
    });

    on("getJoinAddress", (acknowledge) => {
        const address = Object.values(networkInterfaces()).flat()
            .find(info => info?.family === "IPv4" && !info.internal)?.address;
        safeAcknowledge<{ address: string | null }>(acknowledge)({ address: address ?? null });
    });

    // socket.on("registerHost", () => {
    //     registerHost(socket);
    // });

    on("join", (roomId, token, acknowledge) => {
        joinPlayer(socket, roomId, token, safeAcknowledge(acknowledge));
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

    on("setRoomLocked", (locked, acknowledge) => {
        setRoomLocked(socket, locked, safeAcknowledge(acknowledge));
    });

    on("disconnect", () => {
        disconnectPlayer(socket);
    });
});


// ---- handlers ---- 

function joinPlayer(
    socket: Socket,
    roomId: unknown,
    sessionToken: unknown,
    acknowledge: (response: {
        ok: boolean;
        token?: string;
        error?: string;
        name?: string;
    }) => void,
): void {
    if (!hasSocketConsent(socket, sessionToken)) {
        acknowledge({ ok: false, error: "Consent is required before joining" });
        return;
    }

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

    if (room.locked) {
        acknowledge({ ok: false, error: "Room is locked" });
        return;
    }

    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
        acknowledge({ ok: false, error: "Room is full" });
        return;
    }

    // Reuse the browser's secret across rooms; only its hash is public.
    const token = typeof sessionToken === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionToken)
        ? sessionToken : crypto.randomUUID();
    if (getPlayerByToken(token)) {
        acknowledge({ ok: false, error: "You are already in a room. Reconnect to rejoin it." });
        return;
    }

    const usedNames = new Set(
        [...rooms.values()].flatMap(room =>
            [...room.players.values()].map(player =>
                player.name.toLowerCase()
            )
        )
    );

    const name = generatePlayerName(usedNames);

    const player: Player = {
        id: createHash("sha256").update(token).digest("hex"),
        token,
        socketId: socket.id,
        name: name.trim(),
        connected: true,
    };

    room.players.set(player.id, player);
    room.game.recordPlayer(player.id, player.name);
    if (room.game.state.phase === "lobby") {
        room.activePlayerIds.add(player.id);
    }
    attachSocket(socket, room, player);

    if (!room.hostPlayerId) {
        transferHost(room, player.id);
    }

    console.log(
        `Player joined: ${player.name} in room ${room.id}`,
    );

    acknowledge({
        ok: true,
        token: player.token,
        name: player.name,
    });

    if (advanceRoomAfterMembershipChange(room)) {
        return;
    }

    commitRoomState(room);
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
    if (!hasSocketConsent(socket, token)) {
        acknowledge({ ok: false, error: "Consent is required before rejoining" });
        return;
    }

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

    console.log(`Player rejoined: ${foundPlayer.name} in room ${foundRoom.id}`);

    acknowledge({
        ok: true,
        name: foundPlayer.name,
    });

    if (advanceRoomAfterMembershipChange(foundRoom)) {
        return;
    }

    commitRoomState(foundRoom);
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

    console.log(`Answer submitted by ${player.name} in room ${room.id}`);

    acknowledge({
        ok: true,
    });

    if (advanceRoomAfterMembershipChange(room)) {
        return;
    }

    commitRoomState(room);
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
        {
            answerIds: rankedAnswerIds,
            receivedAt: new Date(),
        },
    );

    console.log(`Ranking submitted by ${player.name} in room ${room.id}`);

    acknowledge({
        ok: true,
    });

    tryFinishRanking(room);
    commitRoomState(room);
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
        `Player returned to lobby: ${player.name} (${room.readyPlayers.size}/${getRoundPlayers(room).length})`,
    );

    acknowledge({ ok: true });

    if (tryReturnToLobbyIfReady(room)) {
        return;
    }

    commitRoomState(room);
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

    commitRoomState(room);
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

    commitRoomState(room);
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
    commitRoomState(room);
}
function setRoomLocked(
    socket: Socket,
    locked: unknown,
    acknowledge: (response: { ok: boolean; error?: string }) => void,
): void {
    const result = getPlayerBySocket(socket);
    if (!result) {
        acknowledge({ ok: false, error: "Player not found" });
        return;
    }

    const { player, room } = result;
    if (player.id !== room.hostPlayerId) {
        acknowledge({ ok: false, error: "Only the host can change room settings" });
        return;
    }

    if (typeof locked !== "boolean") {
        acknowledge({ ok: false, error: "Invalid lock setting" });
        return;
    }

    room.locked = locked;
    acknowledge({ ok: true });
    commitRoomState(room);
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
        // Archive the previous session before replacing the in-memory game.
        room.game.abandonCurrentRound();
        persistRoomGame(room);
        room.game = new Game();
        room.readyPlayers.clear();
        room.activePlayerIds.clear();
        room.hostPlayerId = null;
        room.locked = false;
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
    player.reconnecting = true;
    console.log(`Player disconnected: ${player.name} from room ${room.id}`);

    scheduleDisconnectTimers(room, player);

    if (advanceRoomAfterMembershipChange(room)) {
        return;
    }

    commitRoomState(room);
}

// Phones drop the connection whenever the screen locks, so a disconnect is not final:
// keep waiting for their round actions briefly, then stop waiting; remove them later.
function scheduleDisconnectTimers(room: Room, player: Player): void {
    clearDisconnectTimers(player.id);

    const stillGone = () => room.players.get(player.id) === player && !player.connected;

    const graceTimer = setTimeout(() => {
        try {
            if (!stillGone()) return;

            player.reconnecting = false;
            if (room.hostPlayerId === player.id) {
                console.log(`Host did not come back to room ${room.id}`);
                transferHost(room);
            }

            if (advanceRoomAfterMembershipChange(room)) {
                return;
            }

            commitRoomState(room);
        } catch (error) {
            console.error(`Error ending disconnect grace in room ${room.id}:`, error);
        }
    }, DISCONNECT_GRACE_MS);

    const purgeTimer = setTimeout(() => {
        try {
            if (!stillGone()) return;

            console.log(`Removing disconnected player ${player.name} from room ${room.id}`);
            removePlayerFromRoom(room, player);

            if (advanceRoomAfterMembershipChange(room)) {
                return;
            }

            commitRoomState(room);
        } catch (error) {
            console.error(`Error removing disconnected player from room ${room.id}:`, error);
        }
    }, DISCONNECT_PURGE_MS);

    disconnectTimers.set(player.id, [graceTimer, purgeTimer]);
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

    if (!game.startRound([...room.activePlayerIds])) return;

    const round = game.currentRound();

    if (!round) return;

    console.log(`Room ${room.id} - round ${game.state.round} started`);

    commitRoomState(room);
}


//  ---- Game flow ----


function tryStartVoting(room: Room): void {
    if (room.game.state.phase !== "answering") return;

    const round = room.game.currentRound();
    const roundPlayers = getRoundPlayers(room);

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

    console.log(`Room ${room.id}: everyone answered, starting ranking`);
}

function tryFinishRanking(room: Room): void {
    if (room.game.state.phase !== "ranking") return;

    const round = room.game.currentRound();

    if (!round) return;

    const roundPlayers = getRoundPlayers(room);

    if (roundPlayers.length === 0) return;

    const everyoneRanked = roundPlayers.every(
        player =>
            round.rankings.has(player.id) ||
            !round.answers.some(answer => answer.playerId !== player.id),
    );

    console.log(
        `Room ${room.id}: rankings ${round.rankings.size}/${roundPlayers.length}`,
    );

    if (!everyoneRanked) return;

    console.log(`Room ${room.id}: everyone ranked`);

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

    round.status = "completed";
    round.completedAt = new Date();
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
    const roundPlayers = getRoundPlayers(room);
    const everyoneReady =
        phase === "results" &&
        roundPlayers.length > 0 &&
        roundPlayers.every(player => room.readyPlayers.has(player.id));
    // Nobody playing this round is connected or still within reconnect grace, so the
    // spectators waiting for the next round should not be stuck watching it
    const noActivePlayersConnected =
        roundPlayers.length === 0 && connectedPlayers.length > 0;

    if (!everyoneReady && !noActivePlayersConnected) {
        return false;
    }

    room.game.abandonCurrentRound();
    room.game.state.phase = "lobby";
    setActivePlayersForLobby(room);

    console.log(`Room ${room.id} returned to lobby`);

    commitRoomState(room);
    return true;
}

function setActivePlayersForLobby(room: Room): void {
    room.readyPlayers.clear();
    room.activePlayerIds = new Set(
        getConnectedRoomPlayers(room).map(player => player.id),
    );
}

function getRoundPlayers(room: Room): Player[] {
    return [...room.players.values()].filter(player =>
        room.activePlayerIds.has(player.id) && (player.connected || player.reconnecting),
    );
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
    player.reconnecting = false;
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
// ---- Startup and shutdown ----
async function startServer(): Promise<void> {
    await connectToDatabase();
    httpServer.listen(PORT, HOST, () => {
        console.log(`Game server running on port ${PORT}`);
    });
}

async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
        for (const playerId of disconnectTimers.keys()) {
            clearDisconnectTimers(playerId);
        }
        // Stop clients before the final snapshots; shutdown disconnects are not game actions.
        await new Promise<void>(resolve => io.close(() => resolve()));
        for (const room of rooms.values()) {
            room.game.abandonCurrentRound();
        }
        await Promise.all([...rooms.values()].map(room => saveGame(room.game, room.id)));
        await flushGameSaves();
        await disconnectFromDatabase();
        process.exit(0);
    } catch (error) {
        console.error("Shutdown failed:", error);
        process.exit(1);
    }
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

startServer().catch((error) => {
    console.error("Server startup failed:", error);
    process.exit(1);
});
