import { io } from "socket.io-client";
import { HostView } from "../../server/types.js";

const socket = io();
socket.onAny((event, ...args) => console.log("host got:", event, args));

const statusText = document.querySelector<HTMLParagraphElement>("#status")!;

const playerList =document.querySelector<HTMLUListElement>("#players")!;

const startRoundButton =document.querySelector<HTMLButtonElement>("#start-round")!;

const hostLobby = document.querySelector<HTMLElement>("#host-lobby")!;

const hostPlaying =document.querySelector<HTMLElement>("#host-playing")!;

const roundNumber =document.querySelector<HTMLElement>("#host-round-number")!;

const promptText =document.querySelector<HTMLElement>("#host-prompt")!;

const hostVoting =document.querySelector<HTMLElement>("#host-voting")!;


socket.on("connect", () => {
    statusText.textContent = "Connected as host";
    socket.emit("registerHost");
});


socket.on("state", render);

function render(view: HostView): void {
    hostLobby.hidden = view.phase !== "lobby";
    hostPlaying.hidden = view.phase !== "answering";
    hostVoting.hidden = view.phase !== "ranking";
    
    roundNumber.textContent = `Round ${view.round}`;
    promptText.textContent = view.prompt ?? "";
    
    renderPlayers(view.players);
}


function renderPlayers(players: HostView["players"]): void {
    playerList.replaceChildren();
 
    for (const player of players) {
        const item = document.createElement("li");
 
        item.textContent = "👤 " + player.playerInfo.name;
        item.classList.toggle("answered", player.answered);
        item.classList.toggle("disconnected", !player.playerInfo.connected);
 
        playerList.appendChild(item);
    }
}

startRoundButton.addEventListener(
    "click",
    () => {
        console.log("Start button clicked");
        socket.emit("startRound");
    }
);

