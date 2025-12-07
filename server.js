require('dotenv').config(); // Per gestire le chiavi segrete online
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose'); // Il database manager
const MongoStore = require('connect-mongo'); // Per salvare le sessioni nel DB

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONNESSIONE DATABASE ---
// Se siamo online usa la variabile d'ambiente, altrimenti la stringa locale (o inseriscila qui per test)
const MONGO_URI = process.env.MONGO_URI || "INSERISCI_QUI_LA_TUA_STRINGA_MONGODB_SE_TESTI_IN_LOCALE";

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Database MongoDB Connesso!"))
    .catch(err => console.error("❌ Errore Database:", err));

// --- MODELLO DATI UTENTE (SCHEMA) ---
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    password: { type: String, required: true },
    trips: [{ 
        id: String,
        title: String,
        destination: String,
        startDate: String,
        endDate: String,
        mood: String,
        image: String,
        data: Object // Tutto il JSON dell'itinerario
    }]
});

const User = mongoose.model('User', userSchema);

// --- MIDDLEWARE ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Sessioni persistenti su MongoDB (così se riavvii non slogga)
app.use(session({
    secret: process.env.SESSION_SECRET || 'wayfinder_super_secret',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGO_URI })
}));

// --- ROTTE AUTH ---
app.get('/', (req, res) => {
    if (req.session.userId) return res.redirect('/planner');
    res.render('landing');
});

app.get('/auth', (req, res) => res.render('auth'));

app.post('/register', async (req, res) => {
    const { email, username, password } = req.body;
    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.render('auth', { error: 'Email già registrata!' });

        const hashedPassword = await bcrypt.hash(password, 10);
        
        const newUser = new User({ email, username, password: hashedPassword, trips: [] });
        await newUser.save();

        req.session.userId = newUser._id;
        req.session.username = newUser.username;
        res.redirect('/planner');
    } catch (e) { res.render('auth', { error: 'Errore server.' }); }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) return res.render('auth', { error: 'Utente non trovato.' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.render('auth', { error: 'Password errata.' });

        req.session.userId = user._id;
        req.session.username = user.username;
        res.redirect('/planner');
    } catch (e) { res.render('auth', { error: 'Errore login.' }); }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// --- ROTTE APP ---

app.get('/planner', (req, res) => {
    if (!req.session.userId) return res.redirect('/auth');
    res.render('planner', { user: req.session.username });
});

app.get('/my-trips', async (req, res) => {
    if (!req.session.userId) return res.redirect('/auth');
    const user = await User.findById(req.session.userId);
    res.render('mytrips', { user: user.username, trips: user.trips.reverse() }); // Mostra i più recenti prima
});

app.get('/view-trip/:id', async (req, res) => {
    if (!req.session.userId) return res.redirect('/auth');
    const user = await User.findById(req.session.userId);
    const trip = user.trips.find(t => t.id === req.params.id);
    if (trip) res.render('viewer', { user: user.username, trip: trip });
    else res.redirect('/my-trips');
});

// --- API SALVATAGGIO (MONGODB) ---
app.post('/api/save-trip', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const { itineraryData, overwrite } = req.body;

    try {
        const user = await User.findById(req.session.userId);
        
        // Immagine
        const cleanDest = itineraryData.destination.split(',')[0].trim();
        const imageUrl = `https://image.pollinations.ai/prompt/beautiful%20travel%20photo%20of%20${encodeURIComponent(cleanDest)}%20landmark?width=800&height=600&nologo=true`;

        const tripObject = {
            id: (overwrite && itineraryData.id) ? itineraryData.id : Date.now().toString(),
            title: itineraryData.title || itineraryData.destination,
            destination: itineraryData.destination,
            startDate: itineraryData.startDate,
            endDate: itineraryData.endDate,
            mood: itineraryData.mood,
            image: imageUrl, // Se esisteva già, qui potremmo voler mantenere la vecchia, ma rigenerarla è ok
            data: itineraryData 
        };

        if (overwrite && itineraryData.id) {
            // Trova e aggiorna nel sotto-array
            const index = user.trips.findIndex(t => t.id === itineraryData.id);
            if (index !== -1) {
                // Mantieni la vecchia immagine se non vuoi che cambi ogni volta
                tripObject.image = user.trips[index].image || imageUrl; 
                user.trips[index] = tripObject;
            } else {
                user.trips.push(tripObject);
            }
        } else {
            user.trips.push(tripObject);
        }

        await user.save(); // Salva su MongoDB
        res.json({ success: true, tripId: tripObject.id });

    } catch (e) {
        console.error(e);
        res.json({ success: false });
    }
});

app.get('/api/get-trip/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const user = await User.findById(req.session.userId);
    const trip = user.trips.find(t => t.id === req.params.id);
    if (trip) res.json({ success: true, data: trip.data });
    else res.json({ success: false });
});

app.delete('/api/delete-trip/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false });
    try {
        await User.updateOne(
            { _id: req.session.userId },
            { $pull: { trips: { id: req.params.id } } }
        );
        res.json({ success: true });
    } catch(e) { res.json({ success: false }); }
});

// --- API MAPPA (INVARIATE) ---
// ... (Copia qui le funzioni mapCategory e calculateScore e la rotta /api/generate e /api/search-specific dal server.js precedente. 
// Quelle NON cambiano perché sono logica pura, non database) ...

// PER FACILITARTI, LE RI-INCOLLO QUI SOTTO PER AVERE UN FILE UNICO COPIABILE:

function mapCategory(tags) {
    if (tags.historic || tags.tourism === 'museum' || tags.artwork_type || tags.tourism === 'gallery' || tags.amenity === 'arts_centre') return 'Cultura';
    if (tags.tourism === 'attraction' || tags.tourism === 'viewpoint' || tags.tourism === 'zoo' || tags.tourism === 'theme_park') return 'Attrazione';
    if (tags.amenity === 'restaurant' || tags.cuisine || tags.amenity === 'ice_cream' || tags.amenity === 'fast_food' || tags.amenity === 'cafe') return 'Cibo';
    if (tags.amenity === 'bar' || tags.amenity === 'pub' || tags.amenity === 'nightclub' || tags.amenity === 'biergarten' || tags.amenity === 'casino') return 'Party';
    if (tags.leisure === 'park' || tags.leisure === 'garden' || tags.natural === 'beach' || tags.natural === 'wood' || tags.leisure === 'nature_reserve') return 'Relax';
    return 'Attrazione';
}

function calculateScore(tags, userMood, category) {
    let score = 50;
    if (tags.name) {
        const n = tags.name.toLowerCase();
        if (n.includes('colosseo') || n.includes('colosseum') || n.includes('pantheon') || n.includes('trevi') || n.includes('vatican')) return 1000;
    }
    if (tags.wikipedia) score += 30;
    if (userMood === 'gastronomico' && category === 'Cibo') score += 100;
    if (userMood === 'culturale' && category === 'Cultura') score += 100;
    return Math.min(score, 500);
}

app.post('/api/generate', async (req, res) => {
    const { destination, mood } = req.body;
    if (!destination) return res.status(400).json({ success: false });
    try {
        const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(destination)}&format=json&limit=1`;
        const geoRes = await axios.get(geoUrl, { headers: { 'User-Agent': 'WayFinderApp' } });
        if (!geoRes.data.length) throw new Error("Città non trovata");
        const lat = parseFloat(geoRes.data[0].lat);
        const lon = parseFloat(geoRes.data[0].lon);
        const radius = 8000;
        const query = `[out:json][timeout:90];(nwr["historic"](around:${radius},${lat},${lon});nwr["tourism"~"attraction|museum|viewpoint"](around:${radius},${lat},${lon});nwr["amenity"~"restaurant|cafe|ice_cream|fast_food|bar|pub|nightclub"](around:${radius},${lat},${lon});nwr["leisure"~"park|garden"](around:${radius},${lat},${lon}););out center;`;
        const placesRes = await axios.post('https://overpass-api.de/api/interpreter', query, { maxContentLength: Infinity, maxBodyLength: Infinity });
        
        const buckets = { 'Cultura': [], 'Attrazione': [], 'Cibo': [], 'Party': [], 'Relax': [] };
        const seenNames = new Set();
        if (placesRes.data && placesRes.data.elements) {
            placesRes.data.elements.forEach(item => {
                if (!item.tags || !item.tags.name) return;
                const itemLat = item.lat || (item.center ? item.center.lat : null);
                const itemLon = item.lon || (item.center ? item.center.lon : null);
                if (!itemLat || !itemLon) return;
                if (seenNames.has(item.tags.name)) return;
                seenNames.add(item.tags.name);
                const cat = mapCategory(item.tags);
                const score = calculateScore(item.tags, mood, cat);
                buckets[cat].push({ id: item.id, name: item.tags.name, category: cat, lat: itemLat, lng: itemLon, description: item.tags.description || "", score: score });
            });
        }
        let finalSelection = [];
        const QUOTAS = { 'Cultura': 150, 'Attrazione': 100, 'Cibo': 200, 'Party': 150, 'Relax': 80 };
        Object.keys(buckets).forEach(cat => { buckets[cat].sort((a, b) => b.score - a.score); finalSelection = finalSelection.concat(buckets[cat].slice(0, QUOTAS[cat])); });
        res.json({ success: true, destinationCoords: { lat, lon }, places: finalSelection });
    } catch (error) { res.json({ success: false }); }
});

app.post('/api/search-specific', async (req, res) => {
    const { query, lat, lon } = req.body;
    try {
        const overpassQuery = `[out:json][timeout:25];(nwr["name"~"${query}",i](around:50000,${lat},${lon}););out center;`;
        const resp = await axios.post('https://overpass-api.de/api/interpreter', overpassQuery);
        const results = resp.data.elements.map(item => {
            const itemLat = item.lat || (item.center ? item.center.lat : null);
            const itemLon = item.lon || (item.center ? item.center.lon : null);
            if(!item.tags || !item.tags.name || !itemLat) return null;
            return { id: item.id, name: item.tags.name, category: mapCategory(item.tags), lat: itemLat, lng: itemLon, description: "Risultato Ricerca", score: 2000 };
        }).filter(p => p !== null);
        res.json({ success: true, places: results });
    } catch(e) { res.json({ success: false }); }
});

app.listen(PORT, () => console.log(`Server attivo su http://localhost:${PORT}`));