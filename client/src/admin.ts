// Admin tools. player.ts only loads this module after the server has recognised the session as
// an admin, and the server checks every admin request again; nothing here grants any access.
import type { Socket } from "socket.io-client";
import type { AdminPlayer, AdminRoom, AdminState } from "../../server/admin.js";
import type { AnswerProvenance, PlayerView } from "../../server/types.js";
import "./admin.css";

export type AdminContext = {
    socket: Socket;
    returnToRoomSelection(message?: string): void;
    refreshRoomCards(): void;
};

export type AdminHooks = {
    readonly canBypassLock: boolean;
    afterRender(view: PlayerView): void;
};

type Ack = { ok: boolean; error?: string };

const ACTION_TIMEOUT = 8_000;
const PARTICIPANT_CODE_LENGTH = 12;
const ANNOUNCEMENT_MAX_LENGTH = 200;

const PROVENANCE_LABELS: Record<AnswerProvenance, string> = {
    human_original: "human",
    bot_pregenerated: "preset",
    bot_random: "random words",
    bot_reused_human: "reused human answer",
};

const PHASE_LABELS: Record<AdminRoom["phase"], string> = {
    lobby: "Lobby",
    answering: "Answering",
    ranking: "Ranking",
    results: "Results",
};

const SKIP_LABELS: Record<AdminRoom["phase"], string> = {
    lobby: "Skip phase",
    answering: "End answering now",
    ranking: "End ranking now",
    results: "Close results",
};

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label: string, onClick: () => void, className = "admin-button"): HTMLButtonElement {
    const node = element("button", className, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
}

function badge(player: Pick<AdminPlayer, "isBot">): HTMLElement {
    return element(
        "span",
        `admin-badge ${player.isBot ? "admin-badge-bot" : "admin-badge-human"}`,
        player.isBot ? "BOT" : "HUMAN",
    );
}

export function initAdmin(context: AdminContext): AdminHooks {
    const { socket } = context;
    let state: AdminState | null = null;
    let clockOffset = 0; // server clock minus this browser's clock
    let selectedRoomId: string | null = null;
    let showEmptyRooms = false;
    let ownPlayerId: string | null = null;
    let hidden = false;

    // ---- skeleton, built once so typed messages survive updates ----

    const root = element("div", "admin-root");
    const openButton = button("🛡 Admin", () => setPanelOpen(panel.hidden !== false), "admin-open");
    openButton.setAttribute("aria-expanded", "false");
    const restoreButton = button("", () => setHidden(false), "admin-restore");
    restoreButton.setAttribute("aria-label", "Show admin tools");
    restoreButton.title = "Show admin tools (Ctrl+Shift+A)";

    const banner = element("div", "admin-watch-banner");
    const bannerText = element("span");
    banner.append(bannerText, button("Stop watching", stopWatching, "admin-button admin-button-small"));

    const panel = element("aside", "admin-panel");
    panel.hidden = true;
    panel.setAttribute("aria-label", "Admin panel");

    const header = element("header", "admin-panel-header");
    header.append(
        element("h2", undefined, "Admin"),
        button("Hide admin tools", () => setHidden(true), "admin-button admin-button-small"),
        button("×", () => setPanelOpen(false), "admin-close"),
    );

    const statusLine = element("p", "admin-status");
    statusLine.setAttribute("role", "status");

    const stats = element("dl", "admin-stats");

    const globalSection = element("section", "admin-section");
    const pauseAllButton = button("", () => {
        if (!state) return;
        void act("admin:setBotsPaused", [null, !state.botsPaused], state.botsPaused ? "Bots resumed" : "Bots paused everywhere");
    });
    globalSection.append(
        element("h3", undefined, "Everyone"),
        pauseAllButton,
        announceForm("Message to everyone online", () => null),
    );

    const roomsSection = element("section", "admin-section");
    const emptyToggle = element("label", "admin-checkbox");
    const emptyCheckbox = element("input");
    emptyCheckbox.type = "checkbox";
    emptyCheckbox.addEventListener("change", () => {
        showEmptyRooms = emptyCheckbox.checked;
        renderRoomList();
    });
    emptyToggle.append(emptyCheckbox, " Show empty rooms");
    const roomList = element("ul", "admin-room-list");
    roomsSection.append(element("h3", undefined, "Rooms"), emptyToggle, roomList);

    const detailSection = element("section", "admin-section admin-room-detail");
    const detailBody = element("div");
    detailSection.append(detailBody, announceForm("Message to this room", () => selectedRoomId));

    panel.append(header, statusLine, stats, globalSection, roomsSection, detailSection);
    root.append(openButton, restoreButton, banner, panel);
    document.body.append(root);

    // ---- server communication ----

    socket.on("admin:state", (next: AdminState) => {
        state = next;
        clockOffset = next.serverNow - Date.now();
        applyHidden(next.hidden);
        render();
    });
    socket.on("connect", () => {
        // the server re-sends admin:hello after the consent check; until then the old state is stale
        state = null;
        render();
    });
    socket.emit("admin:getState");

    function act(event: string, args: unknown[], success: string): Promise<boolean> {
        return new Promise(resolve => {
            socket.timeout(ACTION_TIMEOUT).emit(event, ...args, (error: Error | null, response?: Ack) => {
                const ok = !error && response?.ok === true;
                setStatus(ok ? success : error ? "No response from the server" : response?.error ?? "Action failed", !ok);
                resolve(ok);
            });
        });
    }

    let statusTimer: number | undefined;
    function setStatus(message: string, isError = false): void {
        statusLine.textContent = message;
        statusLine.classList.toggle("admin-status-error", isError);
        window.clearTimeout(statusTimer);
        statusTimer = window.setTimeout(() => { statusLine.textContent = ""; }, 5_000);
    }

    // ---- visibility ----

    function setPanelOpen(open: boolean): void {
        panel.hidden = !open;
        openButton.setAttribute("aria-expanded", String(open));
        if (open) render();
    }

    function applyHidden(next: boolean): void {
        if (hidden === next) return;
        hidden = next;
        root.classList.toggle("admin-hidden", hidden);
        context.refreshRoomCards();
        decorateGame();
    }

    function setHidden(next: boolean): void {
        applyHidden(next); // right away; the server remembers it for the next visit
        socket.emit("admin:setHidden", next, () => undefined);
    }

    document.addEventListener("keydown", event => {
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") {
            event.preventDefault();
            setHidden(!hidden);
        }
    });

    // ---- watching a room invisibly ----

    function watch(roomId: string): void {
        void act("admin:spectate", [roomId], `Watching room ${roomId}; players cannot see you`).then(ok => {
            if (ok) setPanelOpen(false);
        });
    }

    function stopWatching(): void {
        void act("admin:stopSpectating", [], "Stopped watching").then(ok => {
            if (ok) context.returnToRoomSelection("Stopped watching.");
        });
    }

    // ---- rendering ----

    function hideEmotesWhileWatching(): void {
        // watchers cannot emote: the server only accepts emotes from players
        if (state?.spectating) document.querySelector<HTMLElement>("#emote-launcher")!.hidden = true;
    }

    function render(): void {
        banner.hidden = !state?.spectating;
        bannerText.textContent = state?.spectating
            ? `👁 Watching room ${state.spectating}, invisible to players`
            : "";
        hideEmotesWhileWatching();
        decorateGame();
        if (panel.hidden) return;

        renderStats();
        if (state) {
            pauseAllButton.textContent = state.botsPaused ? "Resume bots everywhere" : "Pause bots everywhere";
            pauseAllButton.classList.toggle("admin-button-active", state.botsPaused);
        }
        renderRoomList();
        renderRoomDetail();
    }

    function renderStats(): void {
        stats.replaceChildren();
        if (!state) {
            stats.append(element("dd", undefined, "Connecting..."));
            return;
        }

        const { totals } = state;
        const entries: [string, number, string][] = [
            ["Online", totals.online, "Participants with the site open, in a room or not"],
            ["In rooms", totals.inRooms, "Connected as a player in a room"],
            ["Choosing a room", totals.browsing, "Online but not in any room"],
            ["Bots", totals.bots, "Bots in all rooms"],
            ["Connections", totals.visitors, "Open tabs, including the consent screen"],
            ["Admins", totals.admins, "Admins online"],
        ];
        for (const [label, value, description] of entries) {
            const item = element("div", "admin-stat");
            item.title = description;
            item.append(element("dt", undefined, label), element("dd", undefined, String(value)));
            stats.append(item);
        }
    }

    function roomOf(playerId: string | null): AdminRoom | undefined {
        return playerId ? state?.rooms.find(room => room.players.some(player => player.id === playerId)) : undefined;
    }

    function renderRoomList(): void {
        roomList.replaceChildren();
        if (!state) return;

        selectedRoomId ??= state.spectating ?? roomOf(ownPlayerId)?.id
            ?? state.rooms.find(room => room.players.length > 0)?.id ?? null;

        const rooms = [...state.rooms]
            .filter(room => showEmptyRooms || room.players.length > 0 || room.id === selectedRoomId)
            .sort((a, b) => b.players.length - a.players.length || a.id.localeCompare(b.id));

        for (const room of rooms) {
            const humans = room.players.filter(player => !player.isBot).length;
            const botCount = room.players.length - humans;
            const item = element("li");
            const select = button("", () => {
                selectedRoomId = room.id;
                renderRoomList();
                renderRoomDetail();
            }, "admin-room-row");
            select.classList.toggle("admin-room-row-selected", room.id === selectedRoomId);
            select.setAttribute("aria-pressed", String(room.id === selectedRoomId));
            select.append(
                element("strong", undefined, room.id),
                element("span", "admin-room-phase", PHASE_LABELS[room.phase]),
                element("span", "admin-room-counts", `${humans} 👤 · ${botCount} 🤖`),
                element("span", "admin-room-flags", [
                    room.locked ? "🔒" : "",
                    room.spectators > 0 ? "👁" : "",
                    room.botsPaused || room.botsDisabledByHost ? "⏸" : "",
                    room.background ? "bg" : "",
                ].filter(Boolean).join(" ")),
            );
            item.append(select);
            roomList.append(item);
        }

        if (rooms.length === 0) roomList.append(element("li", "admin-empty", "No room has players."));
    }

    function renderRoomDetail(): void {
        detailBody.replaceChildren();
        const room = state?.rooms.find(candidate => candidate.id === selectedRoomId);
        detailSection.hidden = !room;
        if (!state || !room) return;

        const heading = element("h3", undefined, `Room ${room.id}`);
        const summary = element("p", "admin-room-summary");
        summary.append(`${PHASE_LABELS[room.phase]}${room.round > 0 ? ` · round ${room.round}` : ""}`);
        if (room.stageEndsAt !== null) {
            const timer = element("span", "admin-timer");
            timer.dataset.endsAt = String(room.stageEndsAt);
            summary.append(" · ", timer);
        }
        if (room.background) summary.append(" · background bot room");
        if (room.botsDisabledByHost) summary.append(" · host turned bots off");
        if (room.spectators > 0) summary.append(` · ${room.spectators} admin${room.spectators === 1 ? "" : "s"} watching`);

        detailBody.append(heading, summary);
        if (room.prompt) detailBody.append(element("p", "admin-prompt", room.prompt));

        const watching = state.spectating === room.id;
        const actions = element("div", "admin-actions");
        actions.append(
            watching
                ? button("Stop watching", stopWatching)
                : button("Watch invisibly", () => watch(room.id)),
            button(room.locked ? "Unlock room" : "Lock room", () =>
                void act("admin:setLocked", [room.id, !room.locked], room.locked ? "Room unlocked" : "Room locked")),
            button(room.botsPaused ? "Resume bots here" : "Pause bots here", () =>
                void act("admin:setBotsPaused", [room.id, !room.botsPaused], room.botsPaused ? "Bots resumed in this room" : "Bots paused in this room")),
        );
        if (room.phase === "lobby") {
            actions.append(button("Start round", () => void act("admin:startRound", [room.id], "Round started")));
        } else {
            actions.append(
                button(SKIP_LABELS[room.phase], () => {
                    if (window.confirm(`${SKIP_LABELS[room.phase]} in room ${room.id}? Players who have not finished sit out the rest of the round.`)) {
                        void act("admin:skipPhase", [room.id], "Phase skipped");
                    }
                }),
                button("Abandon round", () => {
                    if (window.confirm(`Abandon the current round in room ${room.id} and return everyone to the lobby?`)) {
                        void act("admin:returnToLobby", [room.id], "Round abandoned");
                    }
                }, "admin-button admin-button-danger"),
            );
        }
        detailBody.append(actions);

        detailBody.append(element("h4", undefined, `Players (${room.players.length})`));
        const players = element("ul", "admin-players");
        const humanConnected = room.players.some(player => !player.isBot && player.connected);
        for (const player of room.players) players.append(renderPlayer(room, player, humanConnected));
        if (room.players.length === 0) players.append(element("li", "admin-empty", "Nobody is here."));
        detailBody.append(players);

        if (room.answers.length > 0) {
            detailBody.append(element("h4", undefined, `Answers this round (${room.answers.length})`));
            const answers = element("ul", "admin-answers");
            for (const answer of room.answers) {
                const item = element("li");
                const author = element("span", "admin-answer-author", answer.playerName);
                author.append(element(
                    "span",
                    `admin-badge ${answer.provenance === "human_original" ? "admin-badge-human" : "admin-badge-bot"}`,
                    PROVENANCE_LABELS[answer.provenance],
                ));
                item.append(author, element("span", "admin-answer-words", answer.words.join(" ")));
                answers.append(item);
            }
            detailBody.append(answers);
        }

        updateTimers();
    }

    function renderPlayer(room: AdminRoom, player: AdminPlayer, humanConnected: boolean): HTMLElement {
        const item = element("li");
        item.classList.toggle("admin-player-away", !player.connected);

        const identity = element("div", "admin-player-identity");
        const name = element("span", "admin-player-name", player.name);
        name.append(badge(player));
        if (player.id === ownPlayerId) name.append(element("span", "admin-badge admin-badge-you", "YOU"));
        identity.append(name);
        if (!player.isBot) {
            const code = element("code", "admin-player-id", player.id.slice(0, PARTICIPANT_CODE_LENGTH));
            code.title = `Participant ID ${player.id}`;
            identity.append(code);
        }

        const statuses = [
            player.isHost ? "host" : "",
            player.connected ? "" : player.reconnecting ? "reconnecting" : "disconnected",
            player.isActive ? "" : "spectating",
            room.phase === "answering" && player.isActive ? (player.answered ? "answered" : "thinking") : "",
            room.phase === "ranking" && player.isActive ? (player.ranked ? "ranked" : "ranking") : "",
            room.phase === "results" && player.isActive ? (player.ready ? "back in lobby" : "viewing results") : "",
            `${player.score} pts`,
        ].filter(Boolean);
        identity.append(element("span", "admin-player-status", statuses.join(" · ")));

        const controls = element("div", "admin-player-controls");
        const makeHost = button("Make host", () =>
            void act("admin:transferHost", [room.id, player.id], `${player.name} is now host`), "admin-button admin-button-small");
        makeHost.disabled = player.isHost || !player.connected || (player.isBot && humanConnected);
        const kick = button("Kick", () => {
            if (window.confirm(`Kick ${player.name} from room ${room.id}?`)) {
                void act("admin:kick", [room.id, player.id, false], `${player.name} was kicked`);
            }
        }, "admin-button admin-button-small admin-button-danger");
        controls.append(makeHost, kick);
        if (!player.isBot) {
            controls.append(button("Kick + block 1h", () => {
                if (window.confirm(`Kick ${player.name} and keep them out of room ${room.id} for an hour?`)) {
                    void act("admin:kick", [room.id, player.id, true], `${player.name} was kicked and blocked`);
                }
            }, "admin-button admin-button-small admin-button-danger"));
        }

        item.append(identity, controls);
        return item;
    }

    function announceForm(placeholder: string, target: () => string | null): HTMLFormElement {
        const form = element("form", "admin-announce");
        const input = element("input");
        input.type = "text";
        input.maxLength = ANNOUNCEMENT_MAX_LENGTH;
        input.placeholder = placeholder;
        input.setAttribute("aria-label", placeholder);
        const send = element("button", "admin-button", "Send");
        send.type = "submit";
        form.append(input, send);
        form.addEventListener("submit", event => {
            event.preventDefault();
            const message = input.value.trim();
            if (!message) return;
            const roomId = target();
            void act("admin:announce", [roomId, message], roomId ? `Sent to room ${roomId}` : "Sent to everyone").then(ok => {
                if (ok) input.value = "";
            });
        });
        return form;
    }

    function updateTimers(): void {
        for (const timer of panel.querySelectorAll<HTMLElement>(".admin-timer")) {
            const remaining = Math.max(0, Number(timer.dataset.endsAt) - (Date.now() + clockOffset));
            const seconds = Math.ceil(remaining / 1000);
            timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`;
        }
    }
    window.setInterval(updateTimers, 1_000);

    // ---- marks on the regular game screen ----

    function decorateGame(): void {
        for (const old of document.querySelectorAll(".admin-game-badge")) old.remove();
        if (hidden || !state) return;

        const players = new Map<string, AdminPlayer>();
        const provenance = new Map<string, AnswerProvenance>();
        for (const room of state.rooms) {
            for (const player of room.players) players.set(player.id, player);
            for (const answer of room.answers) provenance.set(answer.playerId, answer.provenance);
        }

        for (const target of document.querySelectorAll<HTMLElement>("[data-player-id]")) {
            const player = players.get(target.dataset.playerId ?? "");
            if (!player) continue;

            // everyone already sees BOT badges; admins also see humans marked and where bot answers came from
            const source = provenance.get(player.id);
            const inResults = target.closest("#round-results") !== null;
            if (player.isBot && !(source && inResults)) continue;

            const mark = badge(player);
            mark.classList.add("admin-game-badge");
            if (player.isBot && source) mark.textContent = PROVENANCE_LABELS[source];
            target.append(mark);
        }
    }

    return {
        get canBypassLock() {
            return !hidden;
        },
        afterRender(view: PlayerView): void {
            ownPlayerId = view.playerId || null;
            hideEmotesWhileWatching();
            decorateGame();
        },
    };
}
