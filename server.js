// Local static server. The game itself runs peer-to-peer in the host's browser (see public/net.js),
// so any static host works, including GitHub Pages.
const path = require('path');
const express = require('express');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// Same as public/404.html on GitHub Pages: /mate opens the "mate" link room.
app.get('/:room', (req, res) => res.redirect(`/?room=${encodeURIComponent(req.params.room.toLowerCase())}`));
app.listen(PORT, () => console.log(`Among Mates running on http://localhost:${PORT}`));
