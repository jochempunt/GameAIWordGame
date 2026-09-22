import { io } from "socket.io-client";
import { RoundState } from "../../server/types.js";


type Player = {
    id: string;
    name: string;
};

type HostRoundStarted = {
    round: number;
    prompt: string;
};


const socket = io();


// ─────────────────────────────
// Elements
// ─────────────────────────────

const statusText =
document.querySelector<HTMLParagraphElement>(
    "#status"
)!;

const playerList =
document.querySelector<HTMLUListElement>(
    "#players"
)!;

const startRoundButton =
document.querySelector<HTMLButtonElement>(
    "#start-round"
)!;

const hostLobby =
document.querySelector<HTMLElement>(
    "#host-lobby"
)!;

const hostPlaying =
document.querySelector<HTMLElement>(
    "#host-playing"
)!;

const roundNumber =
document.querySelector<HTMLElement>(
    "#host-round-number"
)!;

const promptText =
document.querySelector<HTMLElement>(
    "#host-prompt"
)!;

const hostVoting =
document.querySelector<HTMLElement>(
    "#host-voting"
)!;



const option1 = document.querySelector<HTMLElement>(
    "#option1"
)!;

const option2 = document.querySelector<HTMLElement>(
    "#option2"
)!;


// ─────────────────────────────
// Connection
// ─────────────────────────────

socket.on("connect", () => {
    console.log(
        "Host connected:",
        socket.id
    );
    
    statusText.textContent =
    "Connected as host";
    
    socket.emit("registerHost");
});


// ─────────────────────────────
// Players
// ─────────────────────────────

socket.on(
    "playerJoined",
    (player: Player) => {
        const item =
        document.createElement("li");
        
        item.id = `player-${player.id}`;
        item.textContent = player.name;
        
        playerList.appendChild(item);
    }
);

socket.on(
    "playerLeft",
    (playerId: string) => {
        const item =
        document.getElementById(
            `player-${playerId}`
        );
        
        item?.remove();
    }
);


// ─────────────────────────────
// Start round
// ─────────────────────────────

startRoundButton.addEventListener(
    "click",
    () => {
        socket.emit("startRound");
    }
);




// ─────────────────────────────
// Game events
// ─────────────────────────────

socket.on(
    "roundStartedForHost",
    (round: HostRoundStarted) => {
        hostLobby.hidden = true;
        hostPlaying.hidden = false;
        hostVoting.hidden = true;
        
        roundNumber.textContent =
        `Round ${round.round}`;
        
        promptText.textContent =
        round.prompt;
    }
);


socket.on(
    "answerReceived",
    ({ playerId, playerName, answer }: { playerId: string; playerName: string; answer: string[] }) => {
        console.log("Answer received:", playerName, answer);
        
        const item = document.getElementById(
            `player-${playerId}`
        );
        
        if (!item) {
            console.log(
                "Could not find player element:",
                playerId
            );
            return;
        }
        
        item.classList.add("answered");
        
        console.log(
            `Player ${playerId} answered`
        );
    }
);

startRoundButton.addEventListener(
    "click",
    () => {
        console.log("Start button clicked");
        socket.emit("startRound");
    }
);

socket.on("votingStarted", ({ round }: { round: RoundState }) => {
    console.log("Voting started");
    console.log("Round data:", round);
    hostLobby.hidden = true;
    hostPlaying.hidden = true;
    hostVoting.hidden = false;
});