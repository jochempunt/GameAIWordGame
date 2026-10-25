import express from "express";
import { settings } from "./settings_validation.js";
import type { PublicSettings } from "./settings_validation.js";
import { networkInterfaces } from "node:os";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { Server, Socket } from "socket.io";
import { fileURLToPath } from "node:url";

import { Game, MIN_PLAYERS_TO_START } from "./game.js";
import { ANSWER_TIME, rankingTimeForPlayerCount } from "./roundTimer.js";
import type { AnswerOrigin, Player } from "./types.js";
import { viewForPlayer } from "./views.js";
import type { Room, RoomSummary } from "./types.js";
import { connectToDatabase, disconnectFromDatabase } from "./database/db.js";
import { saveGame, flushGameSaves } from "./database/gameRepository.js";
import { generatePlayerName } from "./playerNames.js";
import { hasConsented, recordConsent } from "./database/participantRepository.js";
import { loadReusableAnswers, reusableAnswerStore } from "./database/reusableAnswerRepository.js";
import { findEmote } from "../shared/emotes.js";
import { PROMPTS } from "./prompts.js";
import { WORD_SET } from "./words.js";
import { botSettings } from "./bots/botSettings.js";
import { BotManager } from "./bots/botManager.js";
import { loadPregeneratedPool, ReusableAnswerPool } from "./bots/answerSources.js";
import { preferredHost } from "./bots/population.js";
import { countVisitors, parseAdminIds, playerIdForToken, summarizeRoomForAdmin } from "./admin.js";
import type { AdminState } from "./admin.js";
import { recordAdminAction } from "./database/adminActionRepository.js";


// ---- Setup ----

const PORT = 3000;
const MIN_PLAYERS_TO_LOCK_ROOM = 3;
// Docker sets 0.0.0.0 (see Dockerfile) so the tunnel container can reach the game.
// Everywhere else only this machine can; phones in development go through the Vite dev server.
const HOST = process.env.LISTEN_HOST ?? "127.0.0.1";

const app = express();
const clientDist = fileURLToPath(
    new URL("../client/dist", import.meta.url),
);

// Apply to every HTTP response, including static assets and error pages.
app.use((_request, response, next) => {
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
});
app.use(express.static(clientDist));
const httpServer = createServer(app);
const io = new Server(httpServer);



const rooms = new Map<string, Room>();

const ROOM_CODES = Array.from(
    { length: settings.roomCount },
    (_, index) => String.fromCharCode("A".charCodeAt(0) + index).repeat(4),
);

const EMOTE_SPAM_WINDOW_MS = 5_000;
const EMOTE_SPAM_LIMIT = 3;
const EMOTE_COOLDOWN_MS = 8_000;

const ADMIN_PUSH_DELAY_MS = 300;
const ADMIN_BLOCK_MS = 60 * 60_000;
const ANNOUNCEMENT_MAX_LENGTH = 200;
const { ids: ADMIN_IDS, invalid: invalidAdminIds } = parseAdminIds(process.env.ADMIN_IDS);
if (invalidAdminIds.length > 0) {
    // never echo the entries themselves: they may be session tokens
    console.warn(`ADMIN_IDS: ignored ${invalidAdminIds.length} invalid entr${invalidAdminIds.length === 1 ? "y" : "ies"} (expected participant IDs or session UUIDs)`);
}
console.log(`Admin mode configured for ${ADMIN_IDS.size} participant(s)`);
const hiddenAdmins = new Set<string>(); // admins who hid their tools, by participant id
const spectatorRooms = new Map<string, string>(); // admin socket id -> room watched invisibly
const roomBlocks = new Map<string, Map<string, number>>(); // room id -> player id -> blocked until
let adminPushTimer: NodeJS.Timeout | null = null;

let shuttingDown = false;
const disconnectTimers = new Map<string, NodeJS.Timeout[]>();
const emoteHistory = new Map<string, number[]>();
const emoteCooldownEndsAt = new Map<string, number>();
for (const code of ROOM_CODES) {
    rooms.set(code, {
        id: code,
        game: new Game(),
        players: new Map<string, Player>(),
        readyPlayers: new Set<string>(),
        activePlayerIds: new Set<string>(),
        hostPlayerId: null,
        locked: false,
        stageTimer: null,
        stageEndsAt: null,
    });
}

type Ack<T> = (response: T) => void;
type ActionAck = Ack<{ ok: boolean; error?: string }>;

const reusableAnswers = new ReusableAnswerPool(reusableAnswerStore);

// Bots act through the same handlers as sockets, so they follow every rule humans do.
function botAction(run: (acknowledge: ActionAck) => void): boolean {
    let ok = false;
    run(response => { ok = response.ok; });
    return ok;
}

const bots = new BotManager({
    rooms: () => rooms.values(),
    usedNames: usedPlayerNames,
    addPlayer: addBotToRoom,
    removePlayer: (room, player) => {
        removePlayerFromRoom(room, player);
        if (advanceRoomAfterMembershipChange(room)) return;
        commitRoomState(room);
    },
    transferHost: (room, playerId) => {
        if (transferHost(room, playerId)) commitRoomState(room);
    },
    startRound: (room, player) => startRoundAs(room, player),
    submitAnswer: (room, player, words, origin) =>
        botAction(acknowledge => submitAnswerAs(room, player, words, acknowledge, origin)),
    submitRanking: (room, player, answerIds) =>
        botAction(acknowledge => submitRankingAs(room, player, answerIds, acknowledge)),
    readyForNextRound: (room, player) =>
        botAction(acknowledge => readyForNextRoundAs(room, player, acknowledge)),
    resetGame: (room) => {
        resetRoomGame(room);
        for (const player of room.players.values()) {
            room.game.recordPlayer(player.id, player.name, player.isBot === true);
        }
        setActivePlayersForLobby(room);
        commitRoomState(room);
    },
    sendEmote: (room, player, emoteId) => {
        const emote = findEmote(emoteId);
        if (emote) broadcastEmote(room, player, emote);
    },
}, {
    config: botSettings,
    minPlayersToStart: MIN_PLAYERS_TO_START,
    capacity: settings.maxPlayersPerRoom,
    pregenerated: loadPregeneratedPool(WORD_SET, settings.wordsPerPlayer, PROMPTS),
    reusable: reusableAnswers,
});

function safeAcknowledge<T>(fn: unknown): Ack<T> {  // if something passes non function, we ignore it, so that the server doesnt crash
    return typeof fn === "function" ? (fn as Ack<T>) : () => undefined;
}

function validSessionToken(token: unknown): string | undefined {
    return typeof token === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)
        ? token
        : undefined;
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
        recognizeAdmin(socket);
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
        recognizeAdmin(socket);
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
        capacity: settings.maxPlayersPerRoom,
        phase: room.game.state.phase,
        locked: room.locked,
    }));
}

// Commit after game-flow transitions so the snapshot includes phase changes and scores.
function commitRoomState(room: Room): void {
    persistRoomGame(room);
    pushState(room);
    bots.onRoomCommitted(room);
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
    scheduleAdminPush();
}

function roomView(room: Room, player: Player) {
    return viewForPlayer(
        room.game,
        player,
        room.players.values(),
        room.readyPlayers,
        room.activePlayerIds,
        room.hostPlayerId,
        room.locked,
        room.stageEndsAt,
    );
}

function pushState(room: Room): void {
    pushRoomSummaries();

    for (const player of [...room.players.values()].filter(p => p.connected && !p.isBot)) {
        io.to(player.socketId).emit("state", roomView(room, player));
    }

    for (const [socketId, roomId] of spectatorRooms) {
        if (roomId === room.id) io.to(socketId).emit("state", spectatorView(room, socketId));
    }
}


// ---- Socket events ----


io.on("connection", (socket) => {
    socket.emit("settings", {
        minPlayersToStart: settings.minPlayersToStart,
        visibleEmptyRoomCount: settings.visibleEmptyRoomCount,
    } satisfies PublicSettings);
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

    on("sendEmote", (emoteId, acknowledge) => {
        sendEmote(socket, emoteId, safeAcknowledge(acknowledge));
    });

    on("disconnect", () => {
        stopSpectating(socket);
        disconnectPlayer(socket);
        scheduleAdminPush();
    });

    // ---- admin (every handler checks isAdmin itself) ----

    on("admin:getState", () => {
        if (isAdmin(socket)) pushAdminState([socket]);
    });

    on("admin:setHidden", (hidden, acknowledge) => {
        adminSetHidden(socket, hidden, safeAcknowledge(acknowledge));
    });

    on("admin:spectate", (roomId, acknowledge) => {
        adminSpectate(socket, roomId, safeAcknowledge(acknowledge));
    });

    on("admin:stopSpectating", (acknowledge) => {
        const ack = safeAcknowledge<{ ok: boolean }>(acknowledge);
        if (!isAdmin(socket)) return ack({ ok: false });
        stopSpectating(socket);
        ack({ ok: true });
        scheduleAdminPush();
    });

    on("admin:kick", (roomId, playerId, block, acknowledge) => {
        adminKick(socket, roomId, playerId, block === true, safeAcknowledge(acknowledge));
    });

    on("admin:transferHost", (roomId, playerId, acknowledge) => {
        adminTransferHost(socket, roomId, playerId, safeAcknowledge(acknowledge));
    });

    on("admin:setLocked", (roomId, locked, acknowledge) => {
        adminSetLocked(socket, roomId, locked, safeAcknowledge(acknowledge));
    });

    on("admin:startRound", (roomId, acknowledge) => {
        adminStartRound(socket, roomId, safeAcknowledge(acknowledge));
    });

    on("admin:skipPhase", (roomId, acknowledge) => {
        adminSkipPhase(socket, roomId, safeAcknowledge(acknowledge));
    });

    on("admin:returnToLobby", (roomId, acknowledge) => {
        adminReturnToLobby(socket, roomId, safeAcknowledge(acknowledge));
    });

    on("admin:setBotsPaused", (roomId, paused, acknowledge) => {
        adminSetBotsPaused(socket, roomId, paused, safeAcknowledge(acknowledge));
    });

    on("admin:announce", (roomId, message, acknowledge) => {
        adminAnnounce(socket, roomId, message, safeAcknowledge(acknowledge));
    });

    scheduleAdminPush();
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

    if (room.locked && !isAdmin(socket)) {
        acknowledge({ ok: false, error: "Room is locked" });
        return;
    }

    if (isBlockedFromRoom(room, socket.data.consentedPlayerId)) {
        acknowledge({ ok: false, error: "You cannot join this room right now" });
        return;
    }

    if (room.players.size >= settings.maxPlayersPerRoom) {
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

    const name = generatePlayerName(usedPlayerNames());

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
    stopSpectating(socket);
    attachSocket(socket, room, player);

    if (!hasHumanHost(room)) {
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

    stopSpectating(socket);
    attachSocket(socket, foundRoom, foundPlayer);
    if (foundRoom.game.state.phase === "lobby") {
        foundRoom.activePlayerIds.add(foundPlayer.id);
    }

    if (!hasHumanHost(foundRoom)) {
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

// A bot host only keeps the seat warm: any human taking part takes it over.
function hasHumanHost(room: Room): boolean {
    const host = room.hostPlayerId ? room.players.get(room.hostPlayerId) : undefined;
    return host !== undefined && !host.isBot;
}

function usedPlayerNames(): Set<string> {
    return new Set(
        [...rooms.values()].flatMap(room =>
            [...room.players.values()].map(player =>
                player.name.toLowerCase()
            )
        )
    );
}

function addBotToRoom(room: Room, bot: Player): void {
    if (room.players.size >= settings.maxPlayersPerRoom) return;

    room.players.set(bot.id, bot);
    room.game.recordPlayer(bot.id, bot.name, true);
    if (room.game.state.phase === "lobby") {
        room.activePlayerIds.add(bot.id);
    }
    if (!room.hostPlayerId) {
        transferHost(room, bot.id);
    }

    commitRoomState(room);
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

    submitAnswerAs(result.room, result.player, words, acknowledge);
}

function submitAnswerAs(
    room: Room,
    player: Player,
    words: unknown,
    acknowledge: ActionAck,
    origin?: AnswerOrigin,
): void {
    const game = room.game;

    if (expireStageIfDue(room, "answering")) {
        acknowledge({ ok: false, error: "Answer time has expired" });
        return;
    }

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
        player.isBot ? origin : undefined,
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

    submitRankingAs(result.room, result.player, rankedAnswerIds, acknowledge);
}

function submitRankingAs(
    room: Room,
    player: Player,
    rankedAnswerIds: unknown,
    acknowledge: ActionAck,
): void {
    const game = room.game;

    if (expireStageIfDue(room, "ranking")) {
        acknowledge({ ok: false, error: "Ranking time has expired" });
        return;
    }

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
            ...(player.isBot ? { isBot: true as const } : {}),
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

    readyForNextRoundAs(result.room, result.player, acknowledge);
}

function readyForNextRoundAs(
    room: Room,
    player: Player,
    acknowledge: ActionAck,
): void {
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
    // Exit while watching invisibly just stops watching
    if (stopSpectating(socket)) scheduleAdminPush();
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

    acknowledge({ ok: true });
    kickFromRoom(room, target);
}

function kickFromRoom(room: Room, target: Player): void {
    if (!target.isBot) io.to(target.socketId).emit("kicked");
    removePlayerFromRoom(room, target);

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

    // Worded like a passing hiccup: a refusal must not reveal that the target is a bot.
    const transferFailed = "Host transfer failed. Please try again later.";
    if (room.players.get(targetPlayerId)?.isBot) {
        acknowledge({ ok: false, error: transferFailed });
        return;
    }

    const nextHost = transferHost(room, targetPlayerId);
    if (!nextHost) {
        acknowledge({ ok: false, error: transferFailed });
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

    if (locked && getConnectedHumans(room).length < MIN_PLAYERS_TO_LOCK_ROOM) {
        // only humans count here, so naming the requirement would reveal how many players are bots
        acknowledge({ ok: false, error: "The room can't be locked right now. Please try again later." });
        return;
    }

    room.locked = locked;
    room.adminLocked = false;
    acknowledge({ ok: true });
    commitRoomState(room);
}

function sendEmote(
    socket: Socket,
    emoteId: unknown,
    acknowledge: Ack<{ ok: boolean; cooldownMs?: number; error?: string }>,
): void {
    const result = getPlayerBySocket(socket);
    if (!result) {
        acknowledge({ ok: false, error: "Join a room before sending an emote" });
        return;
    }

    const emote = findEmote(emoteId);
    if (!emote) {
        acknowledge({ ok: false, error: "Unknown emote" });
        return;
    }

    const now = Date.now();
    const cooldownEndsAt = emoteCooldownEndsAt.get(result.player.id) ?? 0;
    if (cooldownEndsAt > now) {
        acknowledge({
            ok: false,
            cooldownMs: cooldownEndsAt - now,
            error: "Emotes are cooling down",
        });
        return;
    }

    const recentEmotes = (emoteHistory.get(result.player.id) ?? [])
        .filter(sentAt => now - sentAt < EMOTE_SPAM_WINDOW_MS);
    if (recentEmotes.length >= EMOTE_SPAM_LIMIT) {
        const endsAt = now + EMOTE_COOLDOWN_MS;
        emoteHistory.delete(result.player.id);
        emoteCooldownEndsAt.set(result.player.id, endsAt);
        acknowledge({
            ok: false,
            cooldownMs: EMOTE_COOLDOWN_MS,
            error: "Too many emotes — cooldown started",
        });
        return;
    }

    recentEmotes.push(now);
    emoteHistory.set(result.player.id, recentEmotes);
    broadcastEmote(result.room, result.player, emote);
    acknowledge({ ok: true });
    bots.onPlayerEmote(result.room, result.player, emote.id);
}

function broadcastEmote(
    room: Room,
    player: Player,
    emote: NonNullable<ReturnType<typeof findEmote>>,
): void {
    const message = emote.messages[Math.floor(Math.random() * emote.messages.length)];

    io.to(room.id).emit("emote", {
        playerId: player.id,
        playerName: player.name,
        emoteId: emote.id,
        icon: emote.icon,
        message,
    });
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
    unlockRoomIfTooSmall(room);

    if (room.players.size === 0) {
        resetRoomGame(room);
        room.hostPlayerId = null;
        room.locked = false;
        room.adminLocked = false;
        return;
    }

    if (wasHost) {
        transferHost(room);
    }
}

function resetRoomGame(room: Room): void {
    // Archive the previous session before replacing the in-memory game.
    clearStageTimer(room);
    bots.onRoomReset(room);
    room.game.abandonCurrentRound();
    persistRoomGame(room);
    room.game = new Game();
    room.readyPlayers.clear();
    room.activePlayerIds.clear();
}

function transferHost(
    room: Room,
    nextHostPlayerId?: string,
): Player | undefined {
    const nextHost = nextHostPlayerId
        ? room.players.get(nextHostPlayerId)
        : preferredHost(room.players.values());

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
    unlockRoomIfTooSmall(room);
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
    }, settings.disconnectGraceMs);

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
    }, settings.disconnectPurgeMs);

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

    startRoundAs(result.room, result.player);
}

function startRoundAs(room: Room, player: Player): boolean {
    const game = room.game;

    if (player.id !== room.hostPlayerId) return false;
    if (game.state.phase !== "lobby") return false;

    setActivePlayersForLobby(room);
    if (room.activePlayerIds.size < MIN_PLAYERS_TO_START) return false;

    if (!game.startRound([...room.activePlayerIds])) return false;

    const round = game.currentRound();

    if (!round) return false;

    bots.onRoundStarted(room);
    scheduleStageTimer(room, "answering", ANSWER_TIME);
    console.log(`Room ${room.id} - round ${game.state.round} started`);

    commitRoomState(room);
    return true;
}


//  ---- Game flow ----

type TimedPhase = "answering" | "ranking";

function clearStageTimer(room: Room): void {
    if (room.stageTimer) clearTimeout(room.stageTimer);
    room.stageTimer = null;
    room.stageEndsAt = null;
}

function scheduleStageTimer(room: Room, phase: TimedPhase, duration: number): void {
    clearStageTimer(room);

    const roundNumber = room.game.state.round;
    room.stageEndsAt = Date.now() + duration;
    room.stageTimer = setTimeout(() => {
        expireStage(room, phase, roundNumber);
    }, duration);
}

function expireStageIfDue(room: Room, phase: TimedPhase): boolean {
    if (room.game.state.phase !== phase || room.stageEndsAt === null || Date.now() < room.stageEndsAt) {
        return false;
    }

    expireStage(room, phase, room.game.state.round);
    return true;
}

function expireStage(room: Room, phase: TimedPhase, roundNumber: number): void {
    if (room.game.state.phase !== phase || room.game.state.round !== roundNumber) return;

    clearStageTimer(room);
    const round = room.game.currentRound();
    if (!round) return;

    let timedOutCount = 0;
    for (const player of room.players.values()) {
        if (!room.activePlayerIds.has(player.id)) continue;

        const completed = phase === "answering"
            ? round.answers.some(answer => answer.playerId === player.id)
            : round.rankings.has(player.id)
                || !round.answers.some(answer => answer.playerId !== player.id);
        if (completed) continue;

        room.activePlayerIds.delete(player.id);
        timedOutCount++;
    }

    console.log(`Room ${room.id}: ${timedOutCount} player(s) timed out during ${phase}`);

    if (advanceRoomAfterMembershipChange(room)) return;
    commitRoomState(room);
}

function tryStartVoting(room: Room): void {
    if (room.game.state.phase !== "answering") return;

    const round = room.game.currentRound();
    const roundPlayers = getRoundPlayers(room);

    if (!round) return;
    if (roundPlayers.length === 0) {
        finishRound(room);
        return;
    }

    const everyoneAnswered = roundPlayers.every(
        (player) =>
            round.answers.some(
                (answer) =>
                    answer.playerId === player.id,
            ),
    );

    if (!everyoneAnswered) return;

    room.game.state.phase = "ranking";
    scheduleStageTimer(room, "ranking", rankingTimeForPlayerCount(roundPlayers.length));

    console.log(`Room ${room.id}: everyone answered, starting ranking`);
}

function tryFinishRanking(room: Room): void {
    if (room.game.state.phase !== "ranking") return;

    const round = room.game.currentRound();

    if (!round) return;

    const roundPlayers = getRoundPlayers(room);

    if (roundPlayers.length === 0) {
        finishRound(room);
        return;
    }

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
    finishRound(room);
}

function finishRound(room: Room): void {
    const round = room.game.currentRound();
    if (!round) return;

    clearStageTimer(room);
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
    bots.onRoundFinished(room);
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

    returnRoomToLobby(room);
    return true;
}

function returnRoomToLobby(room: Room): void {
    clearStageTimer(room);
    room.game.abandonCurrentRound();
    room.game.state.phase = "lobby";
    setActivePlayersForLobby(room);

    console.log(`Room ${room.id} returned to lobby`);

    commitRoomState(room);
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

function unlockRoomIfTooSmall(room: Room): boolean {
    if (!room.locked || room.adminLocked || getConnectedHumans(room).length >= MIN_PLAYERS_TO_LOCK_ROOM) {
        return false;
    }

    room.locked = false;
    console.log(`Room ${room.id} was unlocked because fewer than ${MIN_PLAYERS_TO_LOCK_ROOM} players remain connected`);
    return true;
}
function getConnectedRoomPlayers(room: Room): Player[] {
    return [...room.players.values()].filter(player => player.connected);
}
// Locking keeps others out, so only humans count: bots must not lock a room against new humans.
function getConnectedHumans(room: Room): Player[] {
    return getConnectedRoomPlayers(room).filter(player => !player.isBot);
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
            if (!player.isBot && player.token === token) return { player, room };
        }
    }

    return undefined;
}
// ---- admin ----

// Set only once the session token has passed the consent check and hashes to a configured id.
function isAdmin(socket: Socket): boolean {
    return socket.data.isAdmin === true;
}

function recognizeAdmin(socket: Socket): void {
    const playerId = socket.data.consentedPlayerId;
    if (!playerId || !ADMIN_IDS.has(playerId) || isAdmin(socket)) return;

    socket.data.isAdmin = true;
    console.log(`Admin connected: ${playerId.slice(0, 12)}`);
    socket.emit("admin:hello");
    pushAdminState([socket]);
}

function scheduleAdminPush(): void {
    if (adminPushTimer || shuttingDown) return;
    adminPushTimer = setTimeout(() => {
        adminPushTimer = null;
        try {
            pushAdminState();
        } catch (error) {
            console.error("Could not send admin state:", error);
        }
    }, ADMIN_PUSH_DELAY_MS);
}

function pushAdminState(targets: Socket[] = [...io.sockets.sockets.values()].filter(isAdmin)): void {
    if (targets.length === 0) return;

    const spectatorCounts = new Map<string, number>();
    for (const roomId of spectatorRooms.values()) {
        spectatorCounts.set(roomId, (spectatorCounts.get(roomId) ?? 0) + 1);
    }
    const shared = {
        serverNow: Date.now(),
        botsPaused: bots.isPaused(),
        totals: countVisitors(
            [...io.sockets.sockets.values()].map(socket => socket.data),
            rooms.values(),
            ADMIN_IDS,
        ),
        rooms: [...rooms.values()].map(room => summarizeRoomForAdmin(room, {
            background: bots.isBackgroundRoom(room),
            botsPaused: bots.isPaused(room.id),
            spectators: spectatorCounts.get(room.id) ?? 0,
        })),
    };

    for (const socket of targets) {
        socket.emit("admin:state", {
            ...shared,
            hidden: hiddenAdmins.has(socket.data.consentedPlayerId),
            spectating: spectatorRooms.get(socket.id) ?? null,
        } satisfies AdminState);
    }
}

function adminRoom(socket: Socket, roomId: unknown, acknowledge: ActionAck): Room | undefined {
    if (!isAdmin(socket)) {
        acknowledge({ ok: false, error: "Not allowed" });
        return undefined;
    }

    const room = typeof roomId === "string" ? rooms.get(roomId) : undefined;
    if (!room) acknowledge({ ok: false, error: "Room not found" });
    return room;
}

function audit(
    socket: Socket,
    action: string,
    room?: Room,
    target?: Player,
    details?: Record<string, unknown>,
): void {
    recordAdminAction({
        adminId: socket.data.consentedPlayerId,
        action,
        ...(room ? { roomId: room.id } : {}),
        ...(target ? { targetPlayerId: target.id } : {}),
        ...(details ? { details } : {}),
    });
}

// An observer outside room.players: the view shows the room, but nobody sees or counts them.
function spectatorView(room: Room, socketId: string) {
    return roomView(room, { id: "", token: "", socketId, name: "", connected: true });
}

function stopSpectating(socket: Socket): boolean {
    const roomId = spectatorRooms.get(socket.id);
    if (!roomId) return false;

    spectatorRooms.delete(socket.id);
    if (socket.data.roomId !== roomId) socket.leave(roomId);
    return true;
}

function isBlockedFromRoom(room: Room, playerId: string | undefined): boolean {
    const blocks = roomBlocks.get(room.id);
    const until = playerId ? blocks?.get(playerId) : undefined;
    if (until === undefined) return false;
    if (until > Date.now()) return true;

    blocks!.delete(playerId!);
    return false;
}

function adminSetHidden(socket: Socket, hidden: unknown, acknowledge: ActionAck): void {
    if (!isAdmin(socket) || typeof hidden !== "boolean") {
        acknowledge({ ok: false, error: "Not allowed" });
        return;
    }

    if (hidden) hiddenAdmins.add(socket.data.consentedPlayerId);
    else hiddenAdmins.delete(socket.data.consentedPlayerId);
    acknowledge({ ok: true });
    scheduleAdminPush();
}

function adminSpectate(socket: Socket, roomId: unknown, acknowledge: ActionAck): void {
    const room = adminRoom(socket, roomId, acknowledge);
    if (!room) return;

    if (getPlayerBySocket(socket)) {
        acknowledge({ ok: false, error: "Leave your room before watching another one" });
        return;
    }

    stopSpectating(socket);
    spectatorRooms.set(socket.id, room.id);
    socket.join(room.id); // receives the room's emotes and announcements too
    audit(socket, "spectate", room);
    acknowledge({ ok: true });
    socket.emit("state", spectatorView(room, socket.id));
    scheduleAdminPush();
}

function adminKick(
    socket: Socket,
    roomId: unknown,
    playerId: unknown,
    block: boolean,
    acknowledge: ActionAck,
): void {
    const room = adminRoom(socket, roomId, acknowledge);
    if (!room) return;

    const target = typeof playerId === "string" ? room.players.get(playerId) : undefined;
    if (!target) {
        acknowledge({ ok: false, error: "Player not found" });
        return;
    }

    if (block && !target.isBot) {
        const blocks = roomBlocks.get(room.id) ?? new Map<string, number>();
        blocks.set(target.id, Date.now() + ADMIN_BLOCK_MS);
        roomBlocks.set(room.id, blocks);
    }
    audit(socket, block ? "kick_and_block" : "kick", room, target);
    acknowledge({ ok: true });
    kickFromRoom(room, target);
}

function adminTransferHost(socket: Socket, roomId: unknown, playerId: unknown, acknowledge: ActionAck): void {
    const room = adminRoom(socket, roomId, acknowledge);
    if (!room) return;

    const target = typeof playerId === "string" ? room.players.get(playerId) : undefined;
    if (!target?.connected) {
        acknowledge({ ok: false, error: "Only a connected player can become host" });
        return;
    }
    // the bot manager would hand it straight back to a human anyway
    if (target.isBot && getConnectedHumans(room).length > 0) {
        acknowledge({ ok: false, error: "Bots only host while no human is connected" });
        return;
    }

    transferHost(room, target.id);
    audit(socket, "transfer_host", room, target);
    acknowledge({ ok: true });
    commitRoomState(room);
}

function adminSetLocked(socket: Socket, roomId: unknown, locked: unknown, acknowledge: ActionAck): void {
    const room = adminRoom(socket, roomId, acknowledge);
    if (!room) return;

    if (typeof locked !== "boolean") {
        acknowledge({ ok: false, error: "Invalid lock setting" });
        return;
    }

    // no minimum player count, and it stays locked until someone unlocks it
    room.locked = locked;
    room.adminLocked = locked;
    audit(socket, locked ? "lock" : "unlock", room);
    acknowledge({ ok: true });
    commitRoomState(room);
}

function adminStartRound(socket: Socket, roomId: unknown, acknowledge: ActionAck): void {
    const room = adminRoom(socket, roomId, acknowledge);
    if (!room) return;

    const host = room.hostPlayerId ? room.players.get(room.hostPlayerId) : undefined;
    if (room.game.state.phase !== "lobby") {
        acknowledge({ ok: false, error: "A round is already in progress" });
        return;
    }
    if (!host || !startRoundAs(room, host)) {
        acknowledge({ ok: false, error: `At least ${MIN_PLAYERS_TO_START} connected players and a host are needed` });
        return;
    }

    audit(socket, "start_round", room);
    acknowledge({ ok: true });
}

function adminSkipPhase(socket: Socket, roomId: unknown, acknowledge: ActionAck): void {
    const room = adminRoom(socket, roomId, acknowledge);
    if (!room) return;

    const phase = room.game.state.phase;
    if (phase === "lobby") {
        acknowledge({ ok: false, error: "Nothing to skip in the lobby" });
        return;
    }

    audit(socket, "skip_phase", room, undefined, { phase });
    acknowledge({ ok: true });
    // same as the timer running out: whoever has not acted yet sits out the rest of the round
    if (phase === "results") returnRoomToLobby(room);
    else expireStage(room, phase, room.game.state.round);
}

function adminReturnToLobby(socket: Socket, roomId: unknown, acknowledge: ActionAck): void {
    const room = adminRoom(socket, roomId, acknowledge);
    if (!room) return;

    if (room.game.state.phase === "lobby") {
        acknowledge({ ok: false, error: "The room is already in the lobby" });
        return;
    }

    audit(socket, "return_to_lobby", room, undefined, { phase: room.game.state.phase });
    acknowledge({ ok: true });
    returnRoomToLobby(room);
}

function adminSetBotsPaused(socket: Socket, roomId: unknown, paused: unknown, acknowledge: ActionAck): void {
    if (typeof paused !== "boolean") {
        acknowledge({ ok: false, error: "Invalid bot setting" });
        return;
    }

    if (roomId === null) {
        if (!isAdmin(socket)) {
            acknowledge({ ok: false, error: "Not allowed" });
            return;
        }
        bots.setPaused(paused);
        audit(socket, paused ? "pause_bots" : "resume_bots");
    } else {
        const room = adminRoom(socket, roomId, acknowledge);
        if (!room) return;
        bots.setPaused(paused, room);
        audit(socket, paused ? "pause_bots" : "resume_bots", room);
    }

    acknowledge({ ok: true });
    scheduleAdminPush();
}

function adminAnnounce(socket: Socket, roomId: unknown, message: unknown, acknowledge: ActionAck): void {
    const text = typeof message === "string" ? message.trim().slice(0, ANNOUNCEMENT_MAX_LENGTH) : "";
    if (!text) {
        acknowledge({ ok: false, error: "Write a message first" });
        return;
    }

    if (roomId === null) {
        if (!isAdmin(socket)) {
            acknowledge({ ok: false, error: "Not allowed" });
            return;
        }
        for (const other of io.sockets.sockets.values()) {
            if (other.data.consentedPlayerId) other.emit("announcement", { message: text });
        }
        audit(socket, "announce", undefined, undefined, { message: text });
    } else {
        const room = adminRoom(socket, roomId, acknowledge);
        if (!room) return;
        io.to(room.id).emit("announcement", { message: text });
        audit(socket, "announce", room, undefined, { message: text });
    }

    acknowledge({ ok: true });
}

// ---- Startup and shutdown ----
async function startServer(): Promise<void> {
    await connectToDatabase();
    // answers whose words left words.txt can no longer be dealt
    reusableAnswers.load((await loadReusableAnswers()).filter(answer =>
        answer.words.length <= settings.wordsPerPlayer && answer.words.every(word => WORD_SET.has(word)),
    ));
    console.log(`Loaded ${reusableAnswers.size} reusable human answer(s) for bots`);
    bots.start();
    httpServer.listen(PORT, HOST, () => {
        console.log(`Game server running on port ${PORT}`);
    });
}

async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
        bots.stop();
        if (adminPushTimer) clearTimeout(adminPushTimer);
        for (const playerId of disconnectTimers.keys()) {
            clearDisconnectTimers(playerId);
        }
        for (const room of rooms.values()) {
            clearStageTimer(room);
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
