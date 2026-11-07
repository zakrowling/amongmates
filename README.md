# Among Mates

Online social deduction in space for 2 to 8 mates, plus crewmate bots, played by the rules of Among Us. Play it at **https://zakrowling.github.io/amongmates/** or jump straight into the shared room at **https://zakrowling.github.io/amongmates/mate**.

Inspired by [arizkhalid/among-us-clone](https://github.com/arizkhalid/among-us-clone). All the art here is original and drawn in code.

- **2 to 8 real players, 15 crewmates on board**: empty seats are filled with crewmate bots. There is always **1 Imposter**. With 4 or more real players it's one of you; with fewer, it's one of the bots (the role screen tells the crew so).
- **Crewmates** do tasks at the glowing yellow consoles, report bodies and call emergency meetings. The crew wins when every task is done (the green bar at the top) or when The Imposter is voted off.
- **The Imposter** kills (with a cooldown), hops between connected vents, and sabotages the ship. **Lights** shrink everyone's vision until someone fixes the switches in Electrical. **Reactor** starts a meltdown countdown: someone has to stand at the panel in Reactor before it hits zero. The Imposter wins when only 1 crewmate is left, or when the reactor melts down.
- **Meetings happen on your own voice call** (Discord, FaceTime, whatever you use). There's no chat, and your task list is hidden while you vote: report a body or press the red button in the Cafeteria (1 per player), discuss for 15 seconds, then vote within 30. Votes are shown once everyone has voted or time runs out. The most votes gets ejected (ties and skips eject no one), and the ejection screen says whether they were The Imposter.
- **Ghosts**: dead players (and dead bots) float through walls and keep doing their tasks, so the crew can still win on tasks. Only ghosts can see other ghosts.
- **Bots** walk the ship doing their tasks, report bodies they find, and vote like people. They remember who they saw around, so after a kill they suspect whoever was hanging around the victim (or standing over a body), and anyone they see kill or vent is caught red-handed. In a vote, eyewitnesses speak up first; the rest wait to see which way the room leans and pile on to the front runner (including your votes), follow their hunch, or skip. A bot Imposter hunts crewmates, waits until nobody's watching to strike, votes with the crowd to blend in, and sabotages the lights or reactor.
- **Join mid-round**: a new player takes over a bot's seat (its name, colour, tasks and spot on the ship) and carries on. If someone leaves mid-round, a bot takes over their seat, even if they were The Imposter.
- **Task mini-games**: fix wiring, swipe card (not too fast, not too slow), download/upload data, prime shields, clear asteroids, fuel engines, empty garbage, submit scan, and fixing the lights.
- **Controls**: WASD or arrow keys to move (or drag on the ship on touch screens), hold **Shift** to run at double speed. **E** use, **R** report, **Q** kill, **V** vent, **F** sabotage, **M** map, **Esc** close. Every action also has an on-screen button.
- **Names**: everyone gets a unique 4 to 5 letter name and their own colour when they join (player 1 is mint).
- **Room codes**: create a room and share the 4-letter code (e.g. `WFTF`) or the invite link.
- **Link rooms**: share a link like https://zakrowling.github.io/amongmates/mate and nobody needs a code. The first person to open it hosts and everyone else joins. If the host leaves, the next player takes over hosting, so the room stays open while anyone is in it. If whoever holds the room can't be reached, everyone moves on to the same backup room automatically and still sees the room by its usual name. Any 2 to 16 letters, numbers or dashes work as a room name.
- **Embedding for many groups**: an app that embeds the game can give each group its own private room by passing its own session id: `https://zakrowling.github.io/amongmates/?group=<session id>`. Everyone with the same id lands in the same room, different ids never meet, and ids can be any length or characters (they're hashed into a 4-letter room code). Plain `/mate` stays one shared room.
- **Sound**: "Deep Work" ([`public/assets/sounds/`](public/assets/sounds/)) plays quietly on loop through each round, crossfading into itself at the end so the loop is seamless, and fades out at game over. Sound effects are synthesized with Web Audio and kept spacey rather than retro: soft sine tones and glassy chimes in a long reverb, deep swells and rushes of air (launch, kills, meeting sirens, task chimes, sabotage warnings, reactor sonar pings, vents, ejections). Music and sound-effect buttons at the top right turn each on or off; your choice is remembered on your device and only affects you.

## How it works

There is no game server. Among Mates is peer-to-peer, so it runs on any static host, including GitHub Pages.

- The **host's browser** runs the game engine ([`public/engine.js`](public/engine.js)) at 20 ticks a second: movement and walls, kills, vents, sabotage, meetings, votes, the bots and the win checks. Other players only send which keys they're holding and what they want to do (use, report, kill, vote...), and the host checks every action (range, cooldowns, role) before applying it.
- Each player's role, tasks and cooldowns are sent privately to that player only. Everyone else just sees crewmates.
- The ship layout, task stations, vents and bot pathfinding live in [`public/map.js`](public/map.js), shared by the engine, the renderer and the tests.
- Players connect to the host over WebRTC using [PeerJS](https://peerjs.com/) ([`public/net.js`](public/net.js)). PeerJS's free cloud server only introduces players to each other; game traffic goes directly between browsers.
- Some browser pairs and networks can't connect directly (e.g. phones on mobile data, strict work networks). For those, add a free relay (TURN) server: sign up at [Metered Open Relay](https://www.metered.ca/tools/openrelay/) and paste your credentials URL into `turnCredentialsUrl` in [`public/config.js`](public/config.js).

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 (or http://localhost:3000/mate for the link room). Create a room in one browser window and join with the code from another window or device. An internet connection is still needed to reach the PeerJS service. Add `?debug` (e.g. http://localhost:3000/?debug) to start a round on your own with just bots.

## Test

```bash
npm test
```

## Deploy

Every push to `main` runs the tests and publishes the `public/` folder to GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)).

## Assets

Everything is drawn in code and the sound effects are synthesized; the background music is in `public/assets/sounds/`. The lobby logo is `public/assets/image/amongmates-logo.png`; see [`public/assets/README.md`](public/assets/README.md).
