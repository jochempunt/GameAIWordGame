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

const joinedName = document.querySelector<HTMLElement>("#joined-name")!;

const roundNumber = document.querySelector<HTMLElement>("#round-number")!;
let promptText = document.getElementsByClassName("prompt")[0] as HTMLElement;
const wordsContainer = document.querySelector<HTMLElement>("#words")!;
const answerContainer = document.querySelector<HTMLElement>("#answer")!;
const answersToRankContainer = document.querySelector<HTMLElement>("#answers-to-rank")!;
const answerSubmitButton =
document.querySelector<HTMLButtonElement>("#submit-answer")!;

const submittedAnswer =
document.querySelector<HTMLElement>("#submitted-answer")!;



let selectedWords: string[] = [];
let availableWords: string[] = [];
let currentRound = 0;


socket.on("connect", () => {
    const playerId = localStorage.getItem("playerId");
    
    if (!playerId) {
        showJoin();
        return;
    }
    
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
    
    switch (view.phase) {
        case "lobby":
        renderLobby(view);
        break;
        
        case "answering":
        renderAnswering(view);
        break;
        
        case "ranking":
        renderRanking(view);
        break;
    }
}


function setPrompt(text: string): void {
    for (const el of document.querySelectorAll<HTMLElement>(".prompt")) {
        el.textContent = text;
    }
}

const allViews = [
    joinView,
    lobbyView,
    playingView,
    submittedView,
    rankingView,
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

function renderAnswering(view: ViewOf<"answering">): void {
    if (view.submitted) {
        submittedView.hidden = false;
        renderSubmitted(view.submitted);
        return;
    }
    
    playingView.hidden = false;
    roundNumber.textContent = `Round ${view.round}`;
    setPrompt(view.prompt);
    
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

function renderRanking(view: ViewOf<"ranking">): void {
    rankingView.hidden = false;
    
    setPrompt(view.prompt);
    answersToRankContainer.replaceChildren();
    
    for(const answer of view.answers) {
        if(answer.playerId === localStorage.getItem("playerId")) {
            continue; // skip own answer
        }
        
        const answerElement = document.createElement("li");
        answerElement.classList.add("rankable");
        answerElement.textContent = answer.words.join(" ");
        answersToRankContainer.appendChild(answerElement);
    }   
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