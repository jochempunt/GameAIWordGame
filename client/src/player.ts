import { io } from "socket.io-client";

const socket = io();

type RoundStarted = {
    round: number;
    prompt: string;
    words: string[];
};

const form =
document.querySelector<HTMLFormElement>("#join-form")!;

const nameInput =
document.querySelector<HTMLInputElement>("#name")!;

const statusText =
document.querySelector<HTMLParagraphElement>("#status")!;

const joinView =
document.querySelector<HTMLElement>("#join-view")!;

const lobbyView =
document.querySelector<HTMLElement>("#lobby-view")!;

const playingView =
document.querySelector<HTMLElement>("#playing-view")!;

const joinedName =
document.querySelector<HTMLElement>("#joined-name")!;


const roundNumber =
document.querySelector<HTMLElement>("#round-number")!;

const promptText =
document.querySelector<HTMLElement>("#prompt")!;

const wordsContainer =
document.querySelector<HTMLElement>("#words")!;


const answerContainer =
document.querySelector<HTMLElement>("#answer")!;

const answerPlaceholder =
document.querySelector<HTMLElement>(
    "#answer-placeholder"
)!;

const answerSubmitButton =
document.querySelector<HTMLButtonElement>(
    "#submit-answer"
)!;


const submittedView =
document.querySelector<HTMLElement>(
    "#submitted-view"
)!;

const submittedAnswer =
document.querySelector<HTMLElement>(
    "#submitted-answer"
)!;

const votingView =
document.querySelector<HTMLElement>(
    "#voting-view"
)!;

const votingRoundNumber =
document.querySelector<HTMLElement>(
    "#voting-round-number"
)!;   

let selectedWords: string[] = [];
let currentRound = 0;

function showLobby(name: string) {
    joinView.hidden = true;
    lobbyView.hidden = false;
    playingView.hidden = true;
    submittedView.hidden = true;
    
    joinedName.textContent = name;
}

function showPlaying(round: RoundStarted) {
    joinView.hidden = true;
    lobbyView.hidden = true;
    playingView.hidden = false;
    submittedView.hidden = true;
    votingView.hidden = true;
    
    currentRound = round.round;
    
    roundNumber.textContent =
    `Round ${round.round}`;
    
    promptText.textContent =
    round.prompt;
    
    availableWords = round.words;
    selectedWords = [];
    
    renderAnswer();
    renderAvailableWords();
}


function showSubmitted(answer: string[]) {
    joinView.hidden = true;
    lobbyView.hidden = true;
    playingView.hidden = true;
    submittedView.hidden = false;
    votingView.hidden = true;
    
    submittedAnswer.replaceChildren();
    
    for (const word of answer) {
        const wordElement =
        document.createElement("span");
        
        wordElement.textContent = word;
        wordElement.classList.add("submitted-word");
        
        submittedAnswer.appendChild(wordElement);
    }
}

function showVoting() {
    joinView.hidden = true;
    lobbyView.hidden = true;
    playingView.hidden = true;
    submittedView.hidden = true;
    votingView.hidden = false;
    
    votingRoundNumber.textContent =
    `Round ${currentRound}`;
}

socket.on("votingStarted", () => {
    console.log("Voting started");
    
    showVoting();
});

socket.on("connect", () => {
    const playerId =
    localStorage.getItem("playerId");
    
    if (!playerId) {
        statusText.textContent = "Connected";
        return;
    }
    
    socket.emit(
        "rejoin",
        playerId,
        (response: {
            ok: boolean;
            name?: string;
        }) => {
            if (!response.ok || !response.name) {
                localStorage.removeItem("playerId");
                
                statusText.textContent = "Connected";
                
                return;
            }
            
            showLobby(response.name);
        }
    );
});


answerSubmitButton.addEventListener("click", () => {
    if (selectedWords.length === 0) {
        return;
    }
    
    answerSubmitButton.disabled = true;
    
    socket.emit(
        "submitAnswer",
        selectedWords,
        (response: {
            ok: boolean;
            error?: string;
        }) => {
            if (!response.ok) {
                answerSubmitButton.disabled = false;
                
                console.error(
                    response.error ?? "Submission failed"
                );
                
                return;
            }
            
            showSubmitted(selectedWords);
        }
    );
});



form.addEventListener("submit", (event) => {
    event.preventDefault();
    
    const name = nameInput.value.trim();
    
    if (!name) return;
    
    statusText.classList.remove("status-error");
    statusText.textContent = "Joining...";
    
    socket.emit(
        "join",
        name,
        (response: {
            ok: boolean;
            playerId?: string;
            error?: string;
        }) => {
            if (!response.ok || !response.playerId) {
                statusText.textContent =
                response.error ?? "Could not join";
                
                statusText.classList.add("status-error");
                
                return;
            }
            
            localStorage.setItem(
                "playerId",
                response.playerId
            );
            
            showLobby(name);
        }
    );
});


/// ---- game events

socket.on(
    "roundStarted",
    (round: RoundStarted) => {
        showPlaying(round);
    }
);

let availableWords: string[] = [];

function renderAvailableWords() {
    wordsContainer.replaceChildren();
    
    for (const word of availableWords) {
        const button =
        document.createElement("button");
        
        button.textContent = word;
        button.classList.add("word");
        
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

function selectWord(word: string) {
    selectedWords.push(word);
    
    renderAnswer();
    renderAvailableWords();
}

function removeWord(word: string) {
    const index = selectedWords.indexOf(word);
    
    if (index === -1) {
        return;
    }
    
    selectedWords.splice(index, 1);
    
    renderAnswer();
    renderAvailableWords();
}


function renderAnswer() {
    answerContainer.replaceChildren();
    
    if (selectedWords.length === 0) {
        const placeholder =
        document.createElement("p");
        
        placeholder.id = "answer-placeholder";
        placeholder.textContent =
        "Tap words below to build your answer";
        
        answerContainer.appendChild(placeholder);
        
        answerSubmitButton.disabled = true;
        
        return;
    }
    
    for (const word of selectedWords) {
        const button =
        document.createElement("button");
        
        button.textContent = word;
        button.classList.add(
            "word",
            "selected-word"
        );
        
        button.addEventListener("click", () => {
            removeWord(word);
        });
        
        answerContainer.appendChild(button);
    }
    
    answerSubmitButton.disabled = false;
}


