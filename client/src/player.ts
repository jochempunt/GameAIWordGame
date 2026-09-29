import { io } from "socket.io-client";
import type { PlayerView } from "../../server/types.js";

const socket = io();

type ViewOf<P extends PlayerView["phase"]> = Extract<PlayerView, { phase: P }>;

// ---- html elements ----
const joinForm = document.querySelector<HTMLFormElement>("#join-form")!;
const nameInput = document.querySelector<HTMLInputElement>("#name")!;
const statusText = document.querySelector<HTMLParagraphElement>("#status")!;

const joinView = document.querySelector<HTMLElement>("#join-view")!;
const lobbyView = document.querySelector<HTMLElement>("#lobby-view")!;
const playingView = document.querySelector<HTMLElement>("#playing-view")!;
const submittedView = document.querySelector<HTMLElement>("#submitted-view")!;
const rankingView = document.querySelector<HTMLElement>("#ranking-view")!;
const resultsView = document.querySelector<HTMLElement>("#results-view")!;
const rankingHint = document.querySelector<HTMLElement>("#ranking-hint")!;
const roundResultsContainer = document.querySelector<HTMLElement>("#round-results")!;

const leaderboardContainer = document.querySelector<HTMLElement>("#leaderboard")!;

const readyButton = document.querySelector<HTMLButtonElement>("#ready-button")!;

const readyCount = document.querySelector<HTMLElement>("#ready-count")!;

const rankedView = document.querySelector<HTMLElement>("#ranked-view")!;

const joinedName = document.querySelector<HTMLElement>("#joined-name")!;
const roundNumber = document.querySelector<HTMLElement>("#round-number")!;
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
    const playerId = localStorage.getItem("playerId");
    
    if (!playerId) {
        showJoin();
        return;
    }
    
    skipNextPromptAnimation = true;
    
    socket.emit("rejoin", playerId, (res: { ok: boolean }) => {
        if (!res.ok) {
            localStorage.removeItem("playerId");
            showJoin();
        }
    });
});

socket.on("state", render);

function render(view: PlayerView): void {
    hideAll();
    
    
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


function setPrompt(text: string,animate = false): void {
    
    for (const el of document.querySelectorAll<HTMLElement>(".prompt")) {
        el.textContent = text;
        
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
];

function hideAll(): void {
    for (const view of allViews) {
        view.hidden = true;
    }
}


function showJoin(): void {
    hideAll();
    joinView.hidden = false;
    statusText.textContent = "Connected";
    statusText.classList.remove("status-error");
}

joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    
    const name = nameInput.value.trim();
    
    if (!name) return;
    
    statusText.classList.remove("status-error");
    statusText.textContent = "Joining...";
    
    socket.emit(
        "join",
        name,
        (response: { ok: boolean; playerId?: string; error?: string }) => {
            if (!response.ok || !response.playerId) {
                statusText.textContent = response.error ?? "Could not join";
                statusText.classList.add("status-error");
                return;
            }
            
            localStorage.setItem("playerId", response.playerId);
        },
    );
});


// ---- view rendering ----

function renderLobby(view: ViewOf<"lobby">): void {
    lobbyView.hidden = false;
    joinedName.textContent = view.name;
}

function renderAnswering(view: ViewOf<"answering">, skipAnimation: boolean): void {
    if (view.submitted) {
        submittedView.hidden = false;
        setPrompt(view.prompt);
        answeredCount.textContent = `${view.answeredCount}/${view.playerCount} players answered`;
        renderSubmitted(view.submitted);
        return;
    }
    
    playingView.hidden = false;
    roundNumber.textContent = `Round ${view.round}`;
    
    
    const isNewRound = view.round !== currentRound;
    const shouldAnimate = isNewRound && hasRenderedOnce && !skipAnimation;
    
    setPrompt(view.prompt, shouldAnimate);
    
    // only reset on a new round, so other players updates dont remove picks
    if (view.round !== currentRound) {
        currentRound = view.round;
        selectedWords = [];
    }
    
    availableWords = view.words;
    
    renderAnswer();
    renderAvailableWords();
}

function renderSubmitted(answer: string[]): void {
    submittedAnswer.replaceChildren();
    
    for (const word of answer) {
        const wordElement = document.createElement("span");
        
        wordElement.textContent = word;
        wordElement.classList.add("submitted-word");
        submittedAnswer.appendChild(wordElement);
    }
}

function renderResults(view: ViewOf<"results">): void {
    resultsView.hidden = false;

    setPrompt(view.prompt);

    renderRoundResults(view);
    renderLeaderboard(view);

    readyCount.textContent =
        `${view.readyCount}/${view.playerCount}`;

    readyButton.textContent =
        view.isReady ? "Ready ✓" : "Ready";

    readyButton.disabled = view.isReady;
}

function renderRoundResults(
    view: ViewOf<"results">
): void {

    roundResultsContainer.replaceChildren();

    for (const [index, result] of view.roundResults.entries()) {

        const resultElement =
            document.createElement("div");

        resultElement.classList.add("round-result");

        const position =
            document.createElement("span");

        position.classList.add("result-position");

        position.textContent =
            `${index + 1}.`;

        const answer =
            document.createElement("span");

        answer.classList.add("result-answer");

        answer.textContent =
            result.words.join(" ");

        const score =
            document.createElement("span");

        score.classList.add("result-score");

        score.textContent =
            `${result.score} pts`;

        resultElement.append(
            position,
            answer,
            score,
        );

        roundResultsContainer.appendChild(
            resultElement
        );
    }
}

function renderLeaderboard(
    view: ViewOf<"results">
): void {

    leaderboardContainer.replaceChildren();

    for (const player of view.leaderboard) {

        const playerElement =
            document.createElement("div");

        playerElement.classList.add("leaderboard-player");

        const rank =
            document.createElement("span");

        rank.classList.add("leaderboard-rank");

        rank.textContent =
            `${player.rank}.`;

        const name =
            document.createElement("span");

        name.classList.add("leaderboard-name");

        name.textContent =
            player.playerName;

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
    
    if (view.hasRanked) {
        rankedView.hidden = false;
        setPrompt(view.prompt);
        rankedCount.textContent = `${view.rankedCount}/${view.playerCount} players ranked`;
        return;
    }
    
    rankingView.hidden = false;
    setPrompt(view.prompt);
    
    const localPlayerId = localStorage.getItem("playerId");
    
    currentRankingView = view;
    
    if (rankingRound !== view.round) {
        rankingRound = view.round;
        
        rankedAnswers = view.answers
        .filter(answer => answer.playerId !== localPlayerId)
        .map(answer => answer.id);
        
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
        
        answerElement.innerHTML = `
            <span class="rank-number">
                ${index + 1}
            </span>
        
            <span class="rank-text">
                ${answer.words.join(" ")}
            </span>
        `;
        
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
                console.error(response.error ?? "Submission failed");
            }
        },
    );
});

rankingSubmitButton.addEventListener("click", () => {
    if (!currentRankingView) {
        return;
    }
    
    const localPlayerId = localStorage.getItem("playerId");
    
    if (!localPlayerId) {
        return;
    }
    
    const answerCount = currentRankingView.answers.filter(
        answer => answer.playerId !== localPlayerId,
    ).length;
    
    // Make sure every answer has been ranked.
    if (rankedAnswers.length !== answerCount) {
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
                
                console.error(
                    "Ranking failed:",
                    response.error,
                );
                
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

                console.error(
                    response.error ?? "Could not mark player as ready",
                );
            }
        },
    );
});
