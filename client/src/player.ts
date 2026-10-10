import { io } from "socket.io-client";
import type { PlayerView } from "../../server/types.js";

const socket = io();

type ViewOf<P extends PlayerView["phase"]> = Extract<PlayerView, { phase: P }>;
type PlayerSummary = PlayerView["players"][number];

// ---- html elements ----
const joinForm = document.querySelector<HTMLFormElement>("#join-form")!;
const nameInput = document.querySelector<HTMLInputElement>("#name")!;
const statusText = document.querySelector<HTMLParagraphElement>("#status")!;

const roomCards = document.querySelectorAll<HTMLButtonElement>(".room-card");
const selectedRoomInput = document.querySelector<HTMLInputElement>("#selected-room")!;
const joinSubmitButton = document.querySelector<HTMLButtonElement>("#join-submit")!;
const startRoundButton = document.querySelector<HTMLButtonElement>("#start-round")!;
const startRoundRequirement = document.querySelector<HTMLElement>("#start-round-requirement")!;
const roomOverview = document.querySelector<HTMLElement>("#room-overview")!;
const roomOverviewTitle = document.querySelector<HTMLElement>("#room-overview-title")!;
const roomOverviewStatus = document.querySelector<HTMLElement>("#room-overview-status")!;
const roomPlayers = document.querySelector<HTMLUListElement>("#room-players")!;
const leaveRoomButton = document.querySelector<HTMLButtonElement>("#leave-room")!;
const actionError = document.querySelector<HTMLElement>("#action-error")!;

const joinView = document.querySelector<HTMLElement>("#join-view")!;
const lobbyView = document.querySelector<HTMLElement>("#lobby-view")!;
const playingView = document.querySelector<HTMLElement>("#playing-view")!;
const submittedView = document.querySelector<HTMLElement>("#submitted-view")!;
const rankingView = document.querySelector<HTMLElement>("#ranking-view")!;
const resultsView = document.querySelector<HTMLElement>("#results-view")!;
const spectatorView = document.querySelector<HTMLElement>("#spectator-view")!;
const spectatorTitle = document.querySelector<HTMLElement>("#spectator-title")!;
const spectatorStatus = document.querySelector<HTMLElement>("#spectator-status")!;
const rankingHint = document.querySelector<HTMLElement>("#ranking-hint")!;
const roundResultsContainer = document.querySelector<HTMLElement>("#round-results")!;

const leaderboardContainer = document.querySelector<HTMLElement>("#leaderboard")!;

const readyButton = document.querySelector<HTMLButtonElement>("#ready-button")!;
const readySection = document.querySelector<HTMLElement>("#ready-section")!;

const readyCount = document.querySelector<HTMLElement>("#ready-count")!;

const rankedView = document.querySelector<HTMLElement>("#ranked-view")!;

const joinedName = document.querySelector<HTMLElement>("#joined-name")!;
let promptText = document.getElementsByClassName("prompt")[0] as HTMLElement;

const wordsContainer = document.querySelector<HTMLElement>("#words")!;
const answerContainer = document.querySelector<HTMLElement>("#answer")!;
const answersToRankContainer = document.querySelector<HTMLElement>("#answers-to-rank")!;
const answerSubmitButton = document.querySelector<HTMLButtonElement>("#submit-answer")!;
const submittedAnswer = document.querySelector<HTMLElement>("#submitted-answer")!;

const answeredCount = document.querySelector<HTMLElement>("#answered-count")!;
const rankedCount = document.querySelector<HTMLElement>("#ranked-count")!;

const rankingSubmitButton = document.querySelector<HTMLButtonElement>("#submit-ranking")!;

let selectedWords: string[] = [];
let availableWords: string[] = [];
let rankedAnswers: string[] = [];
let currentRankingView: ViewOf<"ranking"> | null = null;
let selectedAnswerId: string | null = null;
let rankingRound = 0;
let currentRound = 0;

let hasRenderedOnce = false;
let skipNextPromptAnimation = false;


socket.on("connect", () => {
    const sessionToken = localStorage.getItem("sessionToken");

    if (!sessionToken) {
        showJoin();
        return;
    }

    skipNextPromptAnimation = true;

    socket.emit("rejoin", sessionToken, (res: { ok: boolean }) => {
        if (!res.ok) {
            // also resets the picks and rankings left over from the game we were in
            returnToRoomSelection();
        }
    });
});

socket.on("state", render);
socket.on("kicked", () => returnToRoomSelection("You were kicked from the room."));

function render(view: PlayerView): void {
    hideAll();
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
    hideAll();
    joinView.hidden = false;
    roomOverview.hidden = true;
    statusText.textContent = "Connected";
    statusText.classList.remove("status-error");
}

function returnToRoomSelection(message = "Choose a room to join."): void {
    localStorage.removeItem("sessionToken");
    selectedWords = [];
    availableWords = [];
    rankedAnswers = [];
    currentRankingView = null;
    selectedAnswerId = null;
    rankingRound = 0;
    currentRound = 0;
    hasRenderedOnce = false;
    skipNextPromptAnimation = false;

    selectedRoomInput.value = "";
    joinSubmitButton.disabled = true;

    for (const card of roomCards) {
        card.classList.remove("selected");
    }

    showJoin();
    statusText.textContent = message;
}

for (const card of roomCards) {
    card.addEventListener("click", () => {
        for (const c of roomCards) c.classList.remove("selected");
        card.classList.add("selected");
        selectedRoomInput.value = card.dataset.roomId!;
        joinSubmitButton.disabled = false;
    });
}

joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    
    const name = nameInput.value.trim();
    const roomId = selectedRoomInput.value;
    
    if (!name || !roomId) return;
    
    statusText.classList.remove("status-error");
    statusText.textContent = `Joining Room ${roomId}...`;

    // no second join while the first one is still on its way
    joinSubmitButton.disabled = true;

    socket.emit(
        "join",
        roomId,
        name,
        (response: { ok: boolean; token?: string; error?: string }) => {
            joinSubmitButton.disabled = false;

            if (!response.ok || !response.token) {
                statusText.textContent = response.error ?? "Could not join";
                statusText.classList.add("status-error");
                return;
            }

            localStorage.setItem("sessionToken", response.token);
        },
    );
});


// ---- view rendering ----

function renderRoomOverview(view: PlayerView): void {
    roomOverview.hidden = false;
    roomOverviewTitle.textContent = view.isHost ? "You are hosting" : "Room Overview";
    roomOverviewStatus.textContent = roomStatusText(view);
    roomPlayers.replaceChildren();

    const standings = [...view.players].sort((a, b) => b.score - a.score);

    if (standings.length === 0) {
        const empty = document.createElement("li");
        empty.classList.add("standings-empty");
        empty.textContent = "Waiting for our first researchers...";
        roomPlayers.appendChild(empty);
        return;
    }

    let rank = 1;

    for (const [index, player] of standings.entries()) {
        if (index > 0 && player.score !== standings[index - 1].score) {
            rank = index + 1;
        }

        const item = document.createElement("li");
        const position = document.createElement("span");
        position.classList.add("leaderboard-rank");
        position.textContent = `${rank}.`;

        const identity = document.createElement("div");
        identity.classList.add("researcher-identity");

        const name = document.createElement("span");
        name.classList.add("leaderboard-name");
        name.textContent = player.name;
        identity.appendChild(name);

        const status = playerStatusText(player, view.phase);
        if (status) {
            const statusElement = document.createElement("span");
            statusElement.classList.add("researcher-status");
            statusElement.textContent = status;
            identity.appendChild(statusElement);
        }

        const score = document.createElement("span");
        score.classList.add("result-score");
        score.textContent = `${player.score} pts`;

        item.append(position, identity, score);

        if (view.isHost) {
            const controls = document.createElement("div");
            controls.classList.add("host-player-controls");

            const kickButton = document.createElement("button");
            kickButton.type = "button";
            kickButton.textContent = "Kick";
            kickButton.addEventListener("click", () => emitHostPlayerAction("kickPlayer", player.id));

            const transferButton = document.createElement("button");
            transferButton.type = "button";
            transferButton.textContent = "Transfer Host";
            transferButton.disabled = player.isHost || !player.connected;
            transferButton.addEventListener("click", () => emitHostPlayerAction("transferHost", player.id));

            controls.append(kickButton, transferButton);
            item.appendChild(controls);
        }

        item.classList.toggle("disconnected", !player.connected);
        roomPlayers.appendChild(item);
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
                return `${view.lobbyCount}/${view.playerCount} players back in the lobby`;
            }

            return view.isHost
                ? "Start the next round when everyone is ready."
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
    lobbyView.hidden = false;
    joinedName.textContent = view.name;
    startRoundButton.hidden = !view.isHost;
    startRoundButton.disabled = !view.canStartRound;
    startRoundRequirement.hidden = !view.isHost || view.canStartRound;
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
    spectatorView.hidden = false;
    spectatorTitle.textContent = title;
    spectatorStatus.textContent = status;
    setPrompt(prompt, round);
}
function renderSubmitted(answer: string[]): void {
    submittedAnswer.textContent = answer.join(" ");
}

function renderResults(view: ViewOf<"results">): void {
    resultsView.hidden = false;
    
    setPrompt(view.prompt, view.round);
    
    renderRoundResults(view);
    renderLeaderboard(view);
    
    readySection.hidden = !view.canReady;
    readyCount.textContent =
    `${view.readyCount}/${view.playerCount}`;
    
    readyButton.textContent =
    view.isReady ? "In lobby" : "Ready";
    
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
        playerName.setAttribute("aria-label", `Source ${index + 1}: ${result.playerName}`);
        
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

function renderLeaderboard(
    view: ViewOf<"results">
): void {
    
    // The leaderboard markup is temporarily commented out.
    if (!leaderboardContainer) return;
    
    leaderboardContainer.replaceChildren();
    
    for (const player of view.leaderboard) {
        
        const playerElement =
        document.createElement("div");
        
        playerElement.classList.add("leaderboard-player");
        
        const rank =document.createElement("span");
        
        rank.classList.add("leaderboard-rank");
        
        rank.textContent =
        `${player.rank}.`;
        
        const name = document.createElement("span");
        
        name.classList.add("leaderboard-name");
        
        name.textContent = player.playerName;
        
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
    if (!view.canRank) {
        renderSpectating(
            "Watching the review",
            view.prompt,
            view.round,
            `${view.rankedCount}/${view.playerCount} players ranked`,
        );
        return;
    }
    
    if (view.hasRanked) {
        rankedView.hidden = false;
        setPrompt(view.prompt, view.round);
        rankedCount.textContent = `${view.rankedCount}/${view.playerCount} players ranked`;
        return;
    }
    
    rankingView.hidden = false;
    setPrompt(view.prompt, view.round);
    
    currentRankingView = view;

    if (rankingRound !== view.round) {
        rankingRound = view.round;

        // the server only sends the answers this player has to rank
        rankedAnswers = view.answers.map(answer => answer.id);
        
        selectedAnswerId = null;
    }
    
    answersToRankContainer.replaceChildren();
    
    const answersById = new Map(
        view.answers.map(answer => [answer.id, answer]),
    );
    
    const answerColors = new Map(
        view.answers.map((answer, index) => [
            answer.id,
            `hsl(${(40 + index * 137.508) % 360} 75% 78%)`,
        ]),
    );
    
    rankedAnswers.forEach((answerId, index) => {
        const answer = answersById.get(answerId);
        
        if (!answer) {
            return;
        }
        
        const answerElement = document.createElement("li");
        
        answerElement.classList.add("rankable");
        answerElement.style.setProperty("--rank-accent", answerColors.get(answer.id)!);
        
        answerElement.dataset.answerId = answer.id;
        
        answerElement.draggable = true;
        
        if (selectedAnswerId === answer.id) {
            answerElement.classList.add("selected");
        }
        
        const rankNumber = document.createElement("span");
        rankNumber.classList.add("rank-number");
        rankNumber.textContent = `${index + 1}`;

        const rankText = document.createElement("span");
        rankText.classList.add("rank-text");
        rankText.textContent = answer.words.join(" ");

        answerElement.append(rankNumber, rankText);
        
        // Mouse / touch selection
        answerElement.addEventListener(
            "click",
            handleAnswerClick,
        );
        
        // Desktop drag & drop
        answerElement.addEventListener(
            "dragstart",
            handleDragStart,
        );
        
        answerElement.addEventListener(
            "dragover",
            handleDragOver,
        );
        
        answerElement.addEventListener("dragleave", handleDragLeave);
        
        answerElement.addEventListener(
            "drop",
            handleDrop,
        );
        
        answerElement.addEventListener(
            "dragend",
            handleDragEnd,
        );
        
        answersToRankContainer.appendChild(answerElement);
    });
    
    rankingSubmitButton.disabled =
    rankedAnswers.length === 0;
}


let draggedAnswerId: string | null = null;

function handleDragStart(event: DragEvent): void {
    const element = event.currentTarget as HTMLElement;
    
    draggedAnswerId =
    element.dataset.answerId ?? null;
    
    element.classList.add("dragging");
    
    if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedAnswerId ?? "");
    }
}

function handleDragOver(event: DragEvent): void {
    event.preventDefault();
    
    const element = event.currentTarget as HTMLElement;
    
    for (const item of answersToRankContainer.children) {
        item.classList.toggle("drag-over", item === element && !!draggedAnswerId && element.dataset.answerId !== draggedAnswerId);
    }
    
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
    }
}

function handleDragLeave(event: DragEvent): void {
    const element = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) {
        return;
    }
    element.classList.remove("drag-over");
}

function handleDrop(event: DragEvent): void {
    event.preventDefault();
    
    const targetElement =
    event.currentTarget as HTMLElement;
    
    targetElement.classList.remove("drag-over");
    
    const targetAnswerId =
    targetElement.dataset.answerId;
    
    if (!draggedAnswerId || !targetAnswerId) {
        return;
    }
    
    if (draggedAnswerId === targetAnswerId) {
        return;
    }
    
    const draggedIndex =
    rankedAnswers.indexOf(draggedAnswerId);
    
    const targetIndex =
    rankedAnswers.indexOf(targetAnswerId);
    
    if (
        draggedIndex === -1 ||
        targetIndex === -1
    ) {
        return;
    }
    
    [rankedAnswers[draggedIndex], rankedAnswers[targetIndex]] =
    [rankedAnswers[targetIndex], rankedAnswers[draggedIndex]];
    
    draggedAnswerId = null;
    selectedAnswerId = null;
    
    renderRanking(currentRankingView!);
}

function handleDragEnd(event: DragEvent): void {
    const element =
    event.currentTarget as HTMLElement;
    
    element.classList.remove("dragging");
    
    for (
        const item
        of answersToRankContainer.children
    ) {
        item.classList.remove("drag-over");
    }
    
    draggedAnswerId = null;
}
function handleAnswerClick(event: MouseEvent): void {
    const element = event.currentTarget as HTMLElement;
    
    const answerId = element.dataset.answerId;
    
    if (!answerId) {
        return;
    }
    
    // Nothing selected yet
    if (!selectedAnswerId) {
        selectedAnswerId = answerId;
        
        renderRanking(currentRankingView!);
        
        return;
    }
    
    // Clicked the same answer again
    if (selectedAnswerId === answerId) {
        selectedAnswerId = null;
        
        renderRanking(currentRankingView!);
        
        return;
    }
    
    // Swap the two answers
    const firstIndex =
    rankedAnswers.indexOf(selectedAnswerId);
    
    const secondIndex =
    rankedAnswers.indexOf(answerId);
    
    if (
        firstIndex === -1 ||
        secondIndex === -1
    ) {
        selectedAnswerId = null;
        return;
    }
    
    [
        rankedAnswers[firstIndex],
        rankedAnswers[secondIndex],
    ] = [
        rankedAnswers[secondIndex],
        rankedAnswers[firstIndex],
    ];
    
    selectedAnswerId = null;
    
    renderRanking(currentRankingView!);
}

function renderAvailableWords(): void {
    wordsContainer.replaceChildren();
    
    for (const word of availableWords) {
        const button = document.createElement("button");
        
        button.textContent = word;
        button.classList.add("word");
        button.classList.add("chip");
        
        if (selectedWords.includes(word)) {
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
    
    for (const word of selectedWords) {
        const button = document.createElement("button");
        
        button.textContent = word;
        button.classList.add("word", "selected-word");
        
        button.addEventListener("click", () => {
            removeWord(word);
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

function removeWord(word: string): void {
    const index = selectedWords.indexOf(word);
    
    if (index === -1) {
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
    if (!currentRankingView) {
        return;
    }
    
    // Make sure every answer has been ranked.
    if (rankedAnswers.length !== currentRankingView.answers.length) {
        return;
    }
    
    console.log(
        "[CLIENT] Submitting ranking:",
        rankedAnswers,
    );
    
    rankingSubmitButton.disabled = true;
    
    socket.emit(
        "submitRanking",
        rankedAnswers,
        (response: {
            ok: boolean;
            error?: string;
        }) => {
            console.log(
                "[CLIENT] Ranking response:",
                response,
            );
            
            if (!response.ok) {
                rankingSubmitButton.disabled = false;
                
                showActionError(response.error ?? "Ranking failed");
                
                return;
            }
            
            console.log(
                "[CLIENT] Ranking submitted successfully",
            );
        },
    );
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
