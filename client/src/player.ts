import type { PublicSettings } from "../../server/settings_validation.js";
import { io } from "socket.io-client";
import { createRankBadge } from "./rankBadge.js";
import { RankingPicker } from "./ranking.js";
import { createSessionToken } from "./sessionToken.js";
import type { PlayerView, RoomSummary } from "../../server/types.js";

const socket = io({ autoConnect: false });

function setPageTitle(label: string, round?: number): void {
    const context = round === undefined ? label : `Round ${round} · ${label}`;
    document.title = `${context} | Scientists Explain`;
}

type ViewOf<P extends PlayerView["phase"]> = Extract<PlayerView, { phase: P }>;
type PlayerSummary = PlayerView["players"][number];

// ---- html elements ----
const joinForm = document.querySelector<HTMLFormElement>("#join-form")!;
// const nameInput = document.querySelector<HTMLInputElement>("#name")!;
const statusText = document.querySelector<HTMLParagraphElement>("#status")!;
const consentView = document.querySelector<HTMLElement>("#consent-view")!;
const consentForm = document.querySelector<HTMLFormElement>("#consent-form")!;
const consentChecks = [...consentForm.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
const consentSubmit = document.querySelector<HTMLButtonElement>("#consent-submit")!;
const consentStatus = document.querySelector<HTMLElement>("#consent-status")!;
const participantIdBar = document.querySelector<HTMLElement>("#participant-id")!;
const participantCode = document.querySelector<HTMLElement>("#participant-code")!;
// 12 hex characters identify a participant among millions; researchers look it up by prefix.
const PARTICIPANT_CODE_LENGTH = 12;

const roomCards = document.querySelector<HTMLDivElement>(".room-cards")!;
let rooms: RoomSummary[] = [];
let joiningRoomId: string | null = null;
let settings: PublicSettings;
const startRoundButton = document.querySelector<HTMLButtonElement>("#start-round")!;
const startRoundRequirement = document.querySelector<HTMLElement>("#start-round-requirement")!;
const roomOverview = document.querySelector<HTMLElement>("#room-overview")!;
const roomActions = document.querySelector<HTMLElement>("#room-actions")!;
const roomOverviewTitle = document.querySelector<HTMLElement>("#room-overview-title")!;
const roomOverviewStatus = document.querySelector<HTMLElement>("#room-overview-status")!;
const roomPlayers = document.querySelector<HTMLUListElement>("#room-players")!;
const leaveRoomButton = document.querySelector<HTMLButtonElement>("#leave-room")!;
const actionError = document.querySelector<HTMLElement>("#action-error")!;
const roundTimer = document.querySelector<HTMLElement>("#round-timer")!;
const roundTimerValue = document.querySelector<HTMLElement>("#round-timer-value")!;

const roomSettings = document.querySelector<HTMLDetailsElement>("#room-settings")!;
const roomSettingsPlayers = document.querySelector<HTMLUListElement>("#room-settings-players")!;
const roomLockToggle = document.querySelector<HTMLButtonElement>("#room-lock-toggle")!;
const joinView = document.querySelector<HTMLElement>("#join-view")!;
const lobbyView = document.querySelector<HTMLElement>("#lobby-view")!;
const playingView = document.querySelector<HTMLElement>("#playing-view")!;
const submittedView = document.querySelector<HTMLElement>("#submitted-view")!;
const rankingView = document.querySelector<HTMLElement>("#ranking-view")!;
const resultsView = document.querySelector<HTMLElement>("#results-view")!;
const spectatorView = document.querySelector<HTMLElement>("#spectator-view")!;
const spectatorTitle = document.querySelector<HTMLElement>("#spectator-title")!;
const spectatorStatus = document.querySelector<HTMLElement>("#spectator-status")!;
const roundResultsContainer = document.querySelector<HTMLElement>("#round-results")!;

const leaderboardContainer = document.querySelector<HTMLElement>("#leaderboard")!;

const readyButton = document.querySelector<HTMLButtonElement>("#ready-button")!;
const readySection = document.querySelector<HTMLElement>("#ready-section")!;

const readyCount = document.querySelector<HTMLElement>("#ready-count")!;

const rankedView = document.querySelector<HTMLElement>("#ranked-view")!;

const lobbyStatus = document.querySelector<HTMLElement>("#lobby-status")!;
let promptText = document.getElementsByClassName("prompt")[0] as HTMLElement;

const wordsContainer = document.querySelector<HTMLElement>("#words")!;
const answerContainer = document.querySelector<HTMLElement>("#answer")!;
const answersToRankContainer = document.querySelector<HTMLUListElement>("#answers-to-rank")!;
const answerSubmitButton = document.querySelector<HTMLButtonElement>("#submit-answer")!;
const submittedAnswer = document.querySelector<HTMLElement>("#submitted-answer")!;

const answeredCount = document.querySelector<HTMLElement>("#answered-count")!;
const rankedCount = document.querySelector<HTMLElement>("#ranked-count")!;

const rankingSubmitButton = document.querySelector<HTMLButtonElement>("#submit-ranking")!;

const rankingPicker = new RankingPicker({
    instructions: document.querySelector<HTMLElement>("#ranking-instructions")!,
    choices: answersToRankContainer,
    ranked: document.querySelector<HTMLOListElement>("#ranked-answers")!,
    progress: document.querySelector<HTMLElement>("#ranking-progress")!,
    choicesSection: document.querySelector<HTMLElement>("#ranking-choices-section")!,
    submit: rankingSubmitButton,
});

let selectedWords: string[] = [];
let availableWords: string[] = [];
let currentRankingView: ViewOf<"ranking"> | null = null;
let rankingRound = 0;
let currentRound = 0;

let hasRenderedOnce = false;
let skipNextPromptAnimation = false;

const TIMER_WARNING_TIME = 10_000;
const TIMER_UPDATE_INTERVAL = 250;
let timerEndsAtOnClient: number | null = null;
let timerUpdateInterval: number | null = null;

const sessionToken = getOrCreateSessionToken();
let consented = false;

socket.on("connect", () => {
    setPageTitle("Connecting");
    socket.emit("checkConsent", sessionToken, (response: { ok: boolean; consented: boolean; participantId?: string; error?: string }) => {
        if (!response.ok) {
            showConsent(response.error ?? "Could not verify consent.");
            return;
        }
        if (!response.consented) {
            showConsent();
            return;
        }
        enterGame(response.participantId);
    });
});

function getOrCreateSessionToken(): string {
    const existing = localStorage.getItem("sessionToken");
    if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(existing)) {
        return existing;
    }

    const token = createSessionToken();
    localStorage.setItem("sessionToken", token);
    return token;
}

function showConsent(message = ""): void {
    setPageTitle("Study Consent");
    hideRoundTimer();
    hideAll();
    consentView.hidden = false;
    roomActions.hidden = true;
    consentStatus.textContent = message;
}

function showParticipantId(participantId: string | undefined): void {
    if (!participantId) return;
    participantCode.textContent = participantId.slice(0, PARTICIPANT_CODE_LENGTH);
    participantIdBar.hidden = false;
}

function enterGame(participantId: string | undefined): void {
    showParticipantId(participantId);
    consented = true;
    consentView.hidden = true;
    skipNextPromptAnimation = true;
    socket.emit("getRooms");
    socket.emit("rejoin", sessionToken, (response: { ok: boolean }) => {
        if (!response.ok) returnToRoomSelection();
    });
}

function updateConsentButton(): void {
    consentSubmit.disabled = !consentChecks.every(check => check.checked);
}

consentChecks.forEach(check => check.addEventListener("change", updateConsentButton));
consentForm.addEventListener("submit", event => {
    event.preventDefault();
    if (consentSubmit.disabled) return;

    consentSubmit.disabled = true;
    consentStatus.textContent = "Recording your consent...";
    socket.emit("giveConsent", sessionToken, (response: { ok: boolean; participantId?: string; error?: string }) => {
        if (!response.ok) {
            consentStatus.textContent = response.error ?? "Could not record consent. Please try again.";
            updateConsentButton();
            return;
        }
        enterGame(response.participantId);
    });
});
socket.on("settings", (value: PublicSettings) => {
    settings = value;
    renderRoomCards();
});
socket.on("rooms", (summaries: RoomSummary[]) => {
    if (!consented) return;
    rooms = summaries;
    renderRoomCards();
});
socket.on("disconnect", () => {
    setPageTitle("Reconnecting");
    joiningRoomId = null;
    renderRoomCards();
    statusText.textContent = "Reconnecting...";
});
socket.on("state", view => {
    if (consented) render(view);
});
socket.on("kicked", () => returnToRoomSelection("You were kicked from the room."));

roomLockToggle.addEventListener("click", () => {
    const locked = roomLockToggle.dataset.locked === "true";
    roomLockToggle.disabled = true;
    socket.emit("setRoomLocked", !locked, (response: { ok: boolean; error?: string }) => {
        roomLockToggle.disabled = false;
        if (!response.ok) showActionError(response.error ?? "Could not update room lock");
    });
});

function render(view: PlayerView): void {
    hideAll();
    roomActions.hidden = false;
    renderRoundTimer(view);
    renderRoomSettings(view);
    renderRoomOverview(view);
    
    
    const skipAnimation = skipNextPromptAnimation;
    skipNextPromptAnimation = false;
    
    switch (view.phase) {
        case "lobby":
        renderLobby(view);
        break;
        
        case "answering":
        renderAnswering(view, skipAnimation);
        break;
        
        case "ranking":
        renderRanking(view);
        break;
        
        case "results":
        renderResults(view);
        break;
    }
    
    hasRenderedOnce = true;
}


function renderRoundTimer(view: PlayerView): void {
    if (view.phase !== "answering" && view.phase !== "ranking") {
        hideRoundTimer();
        return;
    }

    timerEndsAtOnClient = performance.now()
        + Math.max(0, view.timer.endsAt - view.timer.serverNow);
    roundTimer.hidden = false;
    updateRoundTimer();

    if (timerUpdateInterval === null) {
        timerUpdateInterval = window.setInterval(updateRoundTimer, TIMER_UPDATE_INTERVAL);
    }
}

function updateRoundTimer(): void {
    if (timerEndsAtOnClient === null || roundTimer.hidden) return;

    const remaining = Math.max(0, timerEndsAtOnClient - performance.now());
    const totalSeconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    roundTimerValue.textContent = `${minutes}:${seconds.toString().padStart(2, "0")}`;
    roundTimer.setAttribute("aria-label", `${totalSeconds} seconds remaining`);
    roundTimer.classList.toggle(
        "round-timer-urgent",
        remaining > 0 && remaining <= TIMER_WARNING_TIME,
    );
}

function hideRoundTimer(): void {
    roundTimer.hidden = true;
    roundTimer.classList.remove("round-timer-urgent");
    timerEndsAtOnClient = null;
    if (timerUpdateInterval !== null) {
        window.clearInterval(timerUpdateInterval);
        timerUpdateInterval = null;
    }
}
function setPrompt(text: string, round: number, animate = false): void {
    
    for (const el of document.querySelectorAll<HTMLElement>(".prompt")) {
        el.textContent = text ? `RQ${round}: ${text}` : "";
        
        if (animate) {
            el.classList.remove("prompt-enter");
            void el.offsetWidth; 
            el.classList.add("prompt-enter");
        } else {
            el.classList.remove("prompt-enter");
        }
    }
}



const allViews = [
    consentView,
    joinView,
    lobbyView,
    playingView,
    submittedView,
    rankingView,
    rankedView,
    resultsView,
    spectatorView,
];

function hideAll(): void {
    for (const view of allViews) {
        view.hidden = true;
    }
}


function showJoin(): void {
    setPageTitle("Choose a Room");
    hideRoundTimer();
    hideAll();
    joinView.hidden = false;
    roomOverview.hidden = true;
    roomActions.hidden = true;
    renderRoomCards();
    statusText.textContent = "Choose a room to join.";
    statusText.classList.remove("status-error");
}

function returnToRoomSelection(message = "Choose a room to join."): void {
    // Keep the session identity when leaving a room or failing to rejoin.
    selectedWords = [];
    availableWords = [];
    rankingPicker.reset();
    currentRankingView = null;
    rankingRound = 0;
    currentRound = 0;
    hasRenderedOnce = false;
    skipNextPromptAnimation = false;

    joiningRoomId = null;

    showJoin();
    statusText.textContent = message;
}

function renderRoomCards(): void {
    roomCards.replaceChildren();
    if (!settings) return;

    // Keep every room with players visible, but only offer a small number of
    // fresh rooms. As soon as one of those is joined, the next empty room is
    // revealed on the next rooms update.
    let visibleEmptyRooms = 0;
    const roomsByPopulation = [...rooms].sort((a, b) =>
        b.playerCount - a.playerCount || a.id.localeCompare(b.id),
    );
    const visibleRooms = roomsByPopulation.filter(room => {
        if (room.playerCount > 0) return true;

        visibleEmptyRooms++;
        return visibleEmptyRooms <= settings.visibleEmptyRoomCount;
    });

    visibleRooms.forEach(room => {
        const card = document.createElement("article");
        card.className = "room-card";
        const heading = document.createElement("div");
        heading.className = "room-card-heading";
        const title = document.createElement("h3");
        title.append("ROOM: ");
        const code = document.createElement("span");
        code.className = "room-code wordmark-highlight";
        code.textContent = room.id;
        title.append(code);
        if (room.locked) {
            const lockIcon = document.createElement("span");
            lockIcon.className = "room-lock-icon";
            lockIcon.textContent = "\u{1F512}";
            lockIcon.setAttribute("aria-label", "Room locked");
            heading.append(title, lockIcon);
        } else {
            heading.append(title);
        }

        const count = document.createElement("p");
        count.className = "room-player-count";
        count.textContent = `${room.playerCount} / ${room.capacity} players joined`;
        const full = room.playerCount >= room.capacity;
        const locked = room.locked;
        const status = document.createElement("p");
        status.className = "room-card-status";
        status.textContent = locked ? "Room locked" : full ? "Room full" : room.phase !== "lobby"
            ? "Round in progress · Join to watch"
            : room.playerCount === 0 ? "Be the first to join" : "In the lobby · Come on in";

        const button = document.createElement("button");
        button.type = "submit";
        button.value = room.id;
        button.className = locked ? "room-join room-join-locked" : "room-join";
        button.textContent = joiningRoomId === room.id ? "Joining..." : locked ? "Locked" : full ? "Full" : "Join room";
        button.setAttribute("aria-label", locked ? `Room ${room.id} is locked` : `Join room ${room.id}`);
        button.setAttribute("aria-disabled", String(locked));
        button.disabled = (!locked && full) || joiningRoomId !== null || !socket.connected;
        card.append(heading, count, status, button);
        roomCards.append(card);
    });
}

joinForm.addEventListener("submit", (event: SubmitEvent) => {
    event.preventDefault();
    const roomId = event.submitter instanceof HTMLButtonElement ? event.submitter.value : "";
/*    const name = nameInput.value.trim();
    if (!name) {
        nameInput.setCustomValidity("Please enter your name.");
        nameInput.reportValidity();
        return;}
*/        
    if (!roomId || joiningRoomId !== null || !socket.connected) return;
    const room = rooms.find(candidate => candidate.id === roomId);
    if (room?.locked) {
        window.alert(`Room ${roomId} is locked. Ask the host to unlock it before joining.`);
        return;
    }
    joiningRoomId = roomId;
    renderRoomCards();
    statusText.classList.remove("status-error");
    statusText.textContent = `Joining Room ${roomId}...`;
    socket.timeout(10000).emit(
        "join", roomId, localStorage.getItem("sessionToken"),
        (error: Error | null, response?: {
            ok: boolean;
            token?: string;
            error?: string;
            name?: string; }) => {
            joiningRoomId = null;
            renderRoomCards();
            if (error || !response?.ok || !response.token) {
                statusText.textContent = error ? "Joining timed out. Please try again." : response?.error ?? "Could not join";
                statusText.classList.add("status-error");
                return;
            }
            localStorage.setItem("sessionToken", response.token);
            statusText.textContent = response.name
            ? `Joined as ${response.name}`
            : "Joined successfully";
        },
    );
});
//nameInput.addEventListener("input", () => nameInput.setCustomValidity(""));


// ---- view rendering ----

function renderRoomOverview(view: PlayerView): void {
    roomOverview.hidden = view.phase !== "lobby";
    if (roomOverview.hidden) return;
    roomOverviewTitle.textContent = view.isHost ? "Your lobby" : "Lobby";
    const connectedCount = view.players.filter(player => player.connected).length;
    roomOverviewStatus.textContent = `${connectedCount} player${connectedCount === 1 ? "" : "s"} connected`;
    roomPlayers.replaceChildren();

    const standings = [...view.players].sort((a, b) =>
        b.averageScore - a.averageScore
        || b.score - a.score
        || a.name.localeCompare(b.name),
    );
    const hasScores = standings.some(player => player.roundsPlayed > 0);

    if (standings.length === 0) {
        const empty = document.createElement("li");
        empty.classList.add("standings-empty");
        empty.textContent = "Waiting for our first researchers...";
        roomPlayers.appendChild(empty);
        return;
    }

    let rank = 1;

    for (const [index, player] of standings.entries()) {
        if (index > 0 && player.averageScore !== standings[index - 1].averageScore) {
            rank = index + 1;
        }

        const item = document.createElement("li");
        const position = createRankBadge(hasScores ? rank : null);

        const identity = document.createElement("div");
        identity.classList.add("researcher-identity");

        const name = document.createElement("span");
        name.classList.add("leaderboard-name");
        name.textContent = player.name;
        appendYouBadge(name, player.id === view.playerId);
        identity.appendChild(name);

        const status = playerStatusText(player, view.phase);
        if (status) {
            const statusElement = document.createElement("span");
            statusElement.classList.add("researcher-status");
            statusElement.textContent = status;
            identity.appendChild(statusElement);
        }

        const score = document.createElement("div");
        score.classList.add("lobby-score-summary");
        score.setAttribute(
            "aria-label",
            `Score ${player.score} points, ${player.roundsPlayed} rounds, average ${formatAverageScore(player.averageScore)} points`,
        );

        const total = document.createElement("span");
        total.textContent = `Score ${player.score} pts`;
        const average = document.createElement("span");
        average.textContent = `${player.roundsPlayed} rounds · Avg. ${formatAverageScore(player.averageScore)}`;
        score.append(total, average);

        item.append(position, identity, score);

        item.classList.toggle("disconnected", !player.connected);
        roomPlayers.appendChild(item);
    }
}

function renderRoomSettings(view: PlayerView): void {
    roomSettings.hidden = !view.isHost;
    roomLockToggle.hidden = !view.isHost;
    if (!view.isHost) {
        roomSettings.open = false;
        return;
    }

    roomLockToggle.dataset.locked = String(view.roomLocked);
    roomLockToggle.textContent = view.roomLocked ? "Unlock room" : "Lock room";
    roomLockToggle.setAttribute("aria-pressed", String(view.roomLocked));

    roomSettingsPlayers.replaceChildren();
    for (const player of view.players) {
        const item = document.createElement("li");
        item.classList.toggle("disconnected", !player.connected);

        const name = document.createElement("span");
        name.textContent = player.name;

        const status = document.createElement("span");
        status.className = "room-settings-player-status";
        status.textContent = player.isHost ? "Host" : player.connected ? "Connected" : "Disconnected";

        const controls = document.createElement("div");
        controls.className = "room-settings-player-controls";

        const kickButton = document.createElement("button");
        kickButton.type = "button";
        kickButton.textContent = "Kick";
        kickButton.disabled = player.isHost;
        kickButton.addEventListener("click", () => emitHostPlayerAction("kickPlayer", player.id));

        const transferButton = document.createElement("button");
        transferButton.type = "button";
        transferButton.textContent = "Transfer host";
        transferButton.disabled = player.isHost || !player.connected;
        transferButton.addEventListener("click", () => emitHostPlayerAction("transferHost", player.id));

        controls.append(kickButton, transferButton);
        item.append(name, status, controls);
        roomSettingsPlayers.appendChild(item);
    }
}

let actionErrorTimer: number | undefined;

// tells the player why an action was refused, then clears itself
function showActionError(message: string): void {
    actionError.textContent = message;
    window.clearTimeout(actionErrorTimer);
    actionErrorTimer = window.setTimeout(() => {
        actionError.textContent = "";
    }, 4000);
}

function emitHostPlayerAction(event: "kickPlayer" | "transferHost", playerId: string): void {
    socket.emit(event, playerId, (response: { ok: boolean; error?: string }) => {
        if (!response.ok) {
            showActionError(response.error ?? "Host action failed");
        }
    });
}

function roomStatusText(view: PlayerView): string {
    switch (view.phase) {
        case "lobby":
            if (!view.canStartRound && view.lobbyCount < view.playerCount) {
                return `${view.lobbyCount}/${view.playerCount} players back in the lobby. Waiting for everyone to click Next.`;
            }

            return view.isHost
                ? view.canStartRound
                    ? "Everyone is here. Start the round when you're ready."
                    : `Invite your friends — you need at least ${settings.minPlayersToStart} players to start.`
                : "Waiting for the host to start the next round.";
        case "answering":
            return view.isSpectator
                ? `${view.answeredCount}/${view.playerCount} players answered - you are spectating`
                : `${view.answeredCount}/${view.playerCount} players answered`;
        case "ranking":
            return view.isSpectator
                ? `${view.rankedCount}/${view.playerCount} players ranked - you are spectating`
                : `${view.rankedCount}/${view.playerCount} players ranked`;
        case "results":
            return view.canReady
                ? `${view.readyCount}/${view.playerCount} players back in the lobby`
                : "You will join when the room returns to the lobby";
    }
}

function playerStatusText(player: PlayerSummary, phase: PlayerView["phase"]): string {
    if (!player.connected) {
        return "Disconnected";
    }

    const labels: string[] = [];

    if (player.isHost) {
        labels.push("Host");
    }

    if (!player.isActive) {
        labels.push("Spectating");
    } else if (phase === "answering") {
        labels.push(player.answered ? "Answer submitted" : "Thinking...");
    } else if (phase === "ranking") {
        labels.push(player.ranked ? "Review submitted" : "Reviewing...");
    }

    return labels.join(" - ");
}

function renderLobby(view: ViewOf<"lobby">): void {
    setPageTitle("Lobby");
    lobbyView.hidden = false;
    lobbyStatus.textContent = roomStatusText(view);
    startRoundButton.hidden = !view.isHost;
    startRoundButton.disabled = !view.canStartRound;
    startRoundRequirement.hidden = !view.isHost || view.canStartRound;
    startRoundRequirement.textContent = view.lobbyCount < view.playerCount
        ? "Everyone must click Next before the next round can start."
        : `Min. ${settings.minPlayersToStart} Players to Start`;
}

function appendYouBadge(element: HTMLElement, isYou: boolean): void {
    if (!isYou) return;
    const badge = document.createElement("span");
    badge.classList.add("you-badge");
    badge.textContent = "YOU";
    element.appendChild(badge);
}

startRoundButton.addEventListener("click", () => {
    socket.emit("startRound");
});

leaveRoomButton.addEventListener("click", () => {
    leaveRoomButton.disabled = true;

    socket.emit(
        "leaveGame",
        (response: { ok: boolean; error?: string }) => {
            leaveRoomButton.disabled = false;

            if (!response.ok) {
                showActionError(response.error ?? "Could not leave room");
                return;
            }

            returnToRoomSelection();
        },
    );
});

function renderAnswering(view: ViewOf<"answering">, skipAnimation: boolean): void {
    if (!view.canSubmit) {
        renderSpectating(
            "Watching this round",
            view.prompt,
            view.round,
            `${view.answeredCount}/${view.playerCount} players answered`,
        );
        return;
    }

    setPageTitle(view.submitted ? "Answer Submitted" : "Build Your Answer", view.round);
    if (view.submitted) {
        submittedView.hidden = false;
        setPrompt(view.prompt, view.round);
        answeredCount.textContent = `${view.answeredCount}/${view.playerCount} players answered`;
        renderSubmitted(view.submitted);
        return;
    }
    
    playingView.hidden = false;
    
    
    const isNewRound = view.round !== currentRound;
    const shouldAnimate = isNewRound && hasRenderedOnce && !skipAnimation;
    
    setPrompt(view.prompt, view.round, shouldAnimate);
    
    // only reset on a new round, so other players updates dont remove picks
    if (view.round !== currentRound) {
        currentRound = view.round;
        selectedWords = [];
    }
    
    availableWords = view.words;
    
    renderAnswer();
    renderAvailableWords();
}

function renderSpectating(
    title: string,
    prompt: string,
    round: number,
    status: string,
): void {
    setPageTitle(title, round);
    spectatorView.hidden = false;
    spectatorTitle.textContent = title;
    spectatorStatus.textContent = status;
    setPrompt(prompt, round);
}
function renderSubmitted(answer: string[]): void {
    submittedAnswer.textContent = answer.join(" ");
}

function renderResults(view: ViewOf<"results">): void {
    setPageTitle("Results", view.round);
    resultsView.hidden = false;
    
    setPrompt(view.prompt, view.round);
    
    renderRoundResults(view);
    renderLeaderboard(view);
    
    readySection.hidden = !view.canReady;
    readyCount.textContent =
    `${view.readyCount}/${view.playerCount}`;
    
    readyButton.textContent =
    view.isReady ? "In lobby" : "Next";
    
    readyButton.disabled = view.isReady || !view.canReady;
}
function renderRoundResults(
    view: ViewOf<"results">
): void {
    
    roundResultsContainer.replaceChildren();
    const winningScore = Math.max(...view.roundResults.map(result => result.score));
    
    for (const [index, result] of view.roundResults.entries()) {
        
        const resultElement =  document.createElement("div");
        resultElement.classList.add("round-result");
        
        const position = document.createElement("span");
        position.classList.add("result-position");
        position.textContent =`${index + 1}.`;
        
        const content = document.createElement("div");
        content.classList.add("result-content");
        
        const playerName = document.createElement("span");
        playerName.classList.add("result-player");
        playerName.textContent = `[${index + 1}] ${result.playerName}`;
        const isYou = result.playerId === view.playerId;
        appendYouBadge(playerName, isYou);
        playerName.setAttribute("aria-label", `Source ${index + 1}: ${result.playerName}${isYou ? " (you)" : ""}`);
        
        const answer = document.createElement("span");
        answer.classList.add("result-answer");
        answer.textContent = result.words.join(" ");
        const citation = document.createElement("sup");
        citation.classList.add("result-citation");
        citation.textContent = `[${index + 1}]`;
        citation.setAttribute("aria-hidden", "true");
        answer.appendChild(citation);
        
        const score = document.createElement("span");
        
        score.classList.add("result-score");
        score.textContent = `${result.score} pts`;
        
        const attribution = document.createElement("div");
        attribution.classList.add("result-attribution");
        attribution.appendChild(playerName);
        content.append(answer, attribution);
        
        resultElement.append(
            position,
            content,
            score,
        );
        
        if (result.score === winningScore) {
            resultElement.classList.add("round-result-winner");
            position.setAttribute("aria-label", `${index + 1}. Winning answer`);
            const finding = document.createElement("span");
            finding.classList.add("confirmed-finding");
            finding.textContent = "Confirmed Finding";
            attribution.appendChild(finding);
            
            const border = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            border.classList.add("winner-border");
            border.setAttribute("aria-hidden", "true");
            border.setAttribute("focusable", "false");
            
            const outline = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            border.appendChild(outline);
            
            resultElement.append(border);
        }
        
        roundResultsContainer.appendChild(
            resultElement
        );
    }
}


function formatAverageScore(score: number): string {
    return Number.isInteger(score) ? String(score) : score.toFixed(1);
}
function renderLeaderboard(
    view: ViewOf<"results">
): void {
    
    // The leaderboard markup is temporarily commented out.
    if (!leaderboardContainer) return;
    
    leaderboardContainer.replaceChildren();
    const hasScores = view.players.some(player => player.score > 0);
    
    for (const player of view.leaderboard) {
        
        const playerElement =
        document.createElement("div");
        
        playerElement.classList.add("leaderboard-player");
        
        const rank = createRankBadge(hasScores ? player.rank : null);
        
        const name = document.createElement("span");
        
        name.classList.add("leaderboard-name");
        
        name.textContent = player.playerName;
        appendYouBadge(name, player.playerId === view.playerId);
        
        playerElement.append(
            rank,
            name,
        );
        
        leaderboardContainer.appendChild(
            playerElement
        );
    }
}

function renderRanking(view: ViewOf<"ranking">): void {
    currentRankingView = view;
    if (!view.canRank) {
        renderSpectating(
            "Watching the review", view.prompt, view.round,
            `${view.rankedCount}/${view.playerCount} players ranked`,
        );
        return;
    }
    setPageTitle(view.hasRanked ? "Ranking Submitted" : "Rank Answers", view.round);
    setPrompt(view.prompt, view.round);
    if (view.hasRanked) {
        rankedView.hidden = false;
        rankedCount.textContent = `${view.rankedCount}/${view.playerCount} players ranked`;
        return;
    }
    rankingView.hidden = false;
    if (rankingRound !== view.round) {
        rankingRound = view.round;
        rankingPicker.reset(view.answers);
    } else {
        rankingPicker.update(view.answers);
    }
}

function renderAvailableWords(): void {
    wordsContainer.replaceChildren();
    const usedCopies = new Map<string, number>();
    for (const word of selectedWords) {
        usedCopies.set(word, (usedCopies.get(word) ?? 0) + 1);
    }

    for (const word of availableWords) {
        const button = document.createElement("button");
        
        button.textContent = word;
        button.classList.add("word");
        button.classList.add("chip");
        
        const used = usedCopies.get(word) ?? 0;
        if (used > 0) {
            usedCopies.set(word, used - 1);
            button.disabled = true;
            button.classList.add("word-used");
        }
        
        button.addEventListener("click", () => {
            selectWord(word);
        });
        
        wordsContainer.appendChild(button);
    }
}

function renderAnswer(): void {
    answerContainer.replaceChildren();
    
    if (selectedWords.length === 0) {
        const placeholder = document.createElement("p");
        
        placeholder.id = "answer-placeholder";
        placeholder.textContent = "Tap words below to build your answer";
        
        answerContainer.appendChild(placeholder);
        
        answerSubmitButton.disabled = true;
        
        return;
    }
    
    for (const [index, word] of selectedWords.entries()) {
        const button = document.createElement("button");
        
        button.textContent = word;
        button.classList.add("word", "selected-word");
        
        button.addEventListener("click", () => {
            removeWord(index);
        });
        
        answerContainer.appendChild(button);
    }
    
    answerSubmitButton.disabled = false;
}


// ---- answering ----

function selectWord(word: string): void {
    selectedWords.push(word);
    
    renderAnswer();
    renderAvailableWords();
}

function removeWord(index: number): void {
    if (index < 0 || index >= selectedWords.length) {
        return;
    }
    
    selectedWords.splice(index, 1);
    
    renderAnswer();
    renderAvailableWords();
}


answerSubmitButton.addEventListener("click", () => {
    if (selectedWords.length === 0) {
        return;
    }
    
    answerSubmitButton.disabled = true;
    
    socket.emit(
        "submitAnswer",
        selectedWords,
        (response: { ok: boolean; error?: string }) => {
            if (!response.ok) {
                answerSubmitButton.disabled = false;
                showActionError(response.error ?? "Submission failed");
            }
        },
    );
});

rankingSubmitButton.addEventListener("click", () => {
    if (!currentRankingView?.canRank || currentRankingView.hasRanked || !rankingPicker.canSubmit) return;
    const rankedAnswers = rankingPicker.answerIds;
    if (rankedAnswers.length !== currentRankingView.answers.length) return;
    rankingPicker.setSubmitting(true);
    socket.emit("submitRanking", rankedAnswers, (response: { ok: boolean; error?: string }) => {
        if (!response.ok) {
            rankingPicker.setSubmitting(false);
            showActionError(response.error ?? "Ranking failed");
        }
    });
});


readyButton.addEventListener("click", () => {
    readyButton.disabled = true;
    
    socket.emit(
        "readyForNextRound",
        (response: {
            ok: boolean;
            error?: string;
        }) => {
            if (!response.ok) {
                readyButton.disabled = false;
                
                showActionError(response.error ?? "Could not mark player as ready");
            }
        },
    );
});

socket.connect();
