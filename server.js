require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

// FIX IMPORTAZIONE MONGOSTORE
// Gestisce sia ambienti locali che cloud per evitare l'errore .create is not a function
const MongoStore = require('connect-mongo').default || require('connect-mongo');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================================================
// 1. CONNESSIONE DATABASE (MongoDB Atlas)
// ==================================================
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.warn("⚠️ ATTENZIONE: Variabile MONGO_URI non trovata. Assicurati di averla settata su Render o nel file .env");
} else {
    mongoose.connect(MONGO_URI)
        .then(() => console.log("✅ Database MongoDB Connesso!"))
        .catch(err => console.error("❌ Errore Connessione DB:", err));
}

// ==================================================
// 2. MODELLI DATI (SCHEMA)
// ==================================================
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    password: { type: String, required: true },
    // Array che contiene tutti i viaggi dell'utente
    trips: [{ 
        id: String,
        title: String,
        destination: String,
        startDate: String,
        endDate: String,
        mood: String,
        image: String,
        data: Object // Contiene tutto il JSON (places, schedule, note, colori)
    }]
});

const User = mongoose.model('User', userSchema);

// ==================================================
// 3. MIDDLEWARE E CONFIGURAZIONE
// ==================================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Aumentiamo il limite per permettere salvataggi di viaggi grossi
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Configurazione Sessione (Salva i login nel database)
app.use(session({
    secret: process.env.SESSION_SECRET || 'wayfinder_secret_key_default',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ 
        mongoUrl: MONGO_URI,
        ttl: 14 * 24 * 60 * 60 // La sessione dura 14 giorni
    })
}));

// ==================================================
// 4. ROTTE DI NAVIGAZIONE E AUTH
// ==================================================

// Home Page (Landing)
app.get('/', (req, res) => {
    if (req.session.userId) return res.redirect('/planner');
    res.render('landing');
});

// Pagina Login/Registrazione
app.get('/auth', (req, res) => {
    res.render('auth');
});

// Processo Registrazione
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
    } catch (e) { 
        console.error(e);
        res.render('auth', { error: 'Errore durante la registrazione.' }); 
    }
});

// Processo Login
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
    } catch (e) { 
        console.error(e);
        res.render('auth', { error: 'Errore durante il login.' }); 
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ==================================================
// 5. ROTTE APPLICAZIONE (PLANNER, DASHBOARD, VIEWER)
// ==================================================

// Planner Principale
app.get('/planner', (req, res) => {
    if (!req.session.userId) return res.redirect('/auth');
    res.render('planner', { user: req.session.username });
});

// Dashboard "I Miei Viaggi"
app.get('/my-trips', async (req, res) => {
    if (!req.session.userId) return res.redirect('/auth');
    try {
        const user = await User.findById(req.session.userId);
        // Mostriamo i viaggi in ordine inverso (dal più recente)
        res.render('mytrips', { user: user.username, trips: user.trips.reverse() });
    } catch (e) { res.redirect('/auth'); }
});

// Viewer (Sola Lettura)
app.get('/view-trip/:id', async (req, res) => {
    if (!req.session.userId) return res.redirect('/auth');
    try {
        const user = await User.findById(req.session.userId);
        const trip = user.trips.find(t => t.id === req.params.id);
        if (trip) res.render('viewer', { user: user.username, trip: trip });
        else res.redirect('/my-trips');
    } catch (e) { res.redirect('/my-trips'); }
});

// ==================================================
// 6. API GESTIONE VIAGGI (SAVE, LOAD, DELETE)
// ==================================================

// Salvataggio Intelligente (Crea o Sovrascrive)
app.post('/api/save-trip', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false });
    
    const { itineraryData, overwrite } = req.body;

    try {
        const user = await User.findById(req.session.userId);
        if (!user) return res.status(404).json({ success: false });

        // LOGICA DI RICERCA:
        // 1. Cerca per ID (se stiamo modificando un viaggio esistente)
        let existingIndex = user.trips.findIndex(t => t.id === itineraryData.id);

        // 2. Se non trova per ID, cerca per TITOLO (se l'utente vuole sovrascrivere un viaggio con lo stesso nome)
        if (existingIndex === -1 && itineraryData.title) {
             existingIndex = user.trips.findIndex(t => t.title.toLowerCase() === itineraryData.title.trim().toLowerCase());
        }

        // Generazione Immagine Copertina (Solo se serve)
        let imageUrl = '';
        if (existingIndex !== -1 && user.trips[existingIndex].image) {
            imageUrl = user.trips[existingIndex].image; // Tieni la vecchia
        } else {
            const cleanDest = itineraryData.destination.split(',')[0].trim();
            imageUrl = `https://image.pollinations.ai/prompt/travel%20photo%20of%20${encodeURIComponent(cleanDest)}%20landmark?width=800&height=600&nologo=true`;
        }

        // Determina l'ID finale (usa quello vecchio se sovrascriviamo, altrimenti nuovo)
        const finalId = (existingIndex !== -1) ? user.trips[existingIndex].id : Date.now().toString();

        // Costruzione Oggetto Viaggio
        const tripObject = {
            id: finalId,
            title: itineraryData.title || itineraryData.destination,
            destination: itineraryData.destination,
            startDate: itineraryData.startDate,
            endDate: itineraryData.endDate,
            mood: itineraryData.mood,
            image: imageUrl,
            data: { ...itineraryData, id: finalId } // Assicura che l'ID dentro i dati sia coerente
        };

        if (existingIndex !== -1) {
            // Se sovrascriviamo (o se abbiamo trovato per nome e l'utente ha detto ok implicitamente nel frontend)
            // Nota: Il frontend gestisce il confirm(), qui eseguiamo.
            user.trips[existingIndex] = tripObject;
            console.log(`♻️ Viaggio aggiornato: ${tripObject.title}`);
        } else {
            // Crea Nuovo
            user.trips.push(tripObject);
            console.log(`✨ Nuovo viaggio creato: ${tripObject.title}`);
        }

        await user.save(); // Scrittura su DB
        
        res.json({ success: true, tripId: finalId });

    } catch (e) {
        console.error("Errore salvataggio:", e);
        res.json({ success: false });
    }
});

// Caricamento Viaggio
app.get('/api/get-trip/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false });
    try {
        const user = await User.findById(req.session.userId);
        const trip = user.trips.find(t => t.id === req.params.id);
        if (trip) res.json({ success: true, data: trip.data });
        else res.json({ success: false, message: "Viaggio non trovato" });
    } catch(e) { res.json({ success: false }); }
});

// Cancellazione Viaggio
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

// ==================================================
// 7. MOTORE DI RICERCA & MAPPA (LOGICA OPENSTREETMAP)
// ==================================================

// Helper per assegnare categorie
function mapCategory(tags) {
    if (tags.historic || tags.tourism === 'museum' || tags.artwork_type || tags.tourism === 'gallery' || tags.amenity === 'arts_centre') return 'Cultura';
    if (tags.tourism === 'attraction' || tags.tourism === 'viewpoint' || tags.tourism === 'zoo' || tags.tourism === 'theme_park') return 'Attrazione';
    if (tags.amenity === 'restaurant' || tags.cuisine || tags.amenity === 'ice_cream' || tags.amenity === 'fast_food' || tags.amenity === 'cafe') return 'Cibo';
    if (tags.amenity === 'bar' || tags.amenity === 'pub' || tags.amenity === 'nightclub' || tags.amenity === 'biergarten' || tags.amenity === 'casino') return 'Party';
    if (tags.leisure === 'park' || tags.leisure === 'garden' || tags.natural === 'beach' || tags.natural === 'wood' || tags.leisure === 'nature_reserve') return 'Relax';
    return 'Attrazione';
}

// Helper per calcolare il punteggio VIP
function calculateScore(tags, userMood, category) {
    let score = 50; 
    
    // 1. SUPER VIP LIST (Questi vincono sempre)
    if (tags.name) {
        const n = tags.name.toLowerCase();
        // Monumenti famosi
        if (n.includes('colosseo') || n.includes('colosseum') || n.includes('pantheon') || n.includes('trevi') || n.includes('vatican') || n.includes('san pietro') || n.includes('duomo') || n.includes('uffizi')) {
            return 1000; 
        }
        // Ristoranti/Locali famosi
        if (n.includes('fortunata') || n.includes('sorbillo') || n.includes('tonnarello') || n.includes('da michele') || n.includes('cencio') || n.includes('florian')) {
            return 900; 
        }
    }

    // 2. Fama e Dati (Qualità)
    if (tags.wikipedia || tags.wikidata) score += 40; 
    if (tags.website || tags['contact:website']) score += 10;
    if (tags.phone || tags['contact:phone']) score += 10;
    if (tags.opening_hours) score += 5;

    // 3. Boost Locali (Parole chiave italiane)
    if (tags.name) {
        const n = tags.name.toLowerCase();
        if (n.includes('osteria') || n.includes('trattoria') || n.includes('enoteca')) score += 15;
    }

    // 4. Boost Mood Utente
    if (userMood === 'gastronomico' && category === 'Cibo') score += 100;
    if (userMood === 'culturale' && category === 'Cultura') score += 100;
    if (userMood === 'divertimento' && category === 'Party') score += 100;
    if (userMood === 'relax' && category === 'Relax') score += 100;

    return Math.min(score, 500);
}

// API GENERAZIONE AUTOMATICA (Area)
app.post('/api/generate', async (req, res) => {
    const { destination, mood } = req.body;
    if (!destination) return res.status(400).json({ success: false });

    console.log(`🔎 Ricerca Area per: ${destination}`);

    try {
        const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(destination)}&format=json&limit=1`;
        const geoRes = await axios.get(geoUrl, { headers: { 'User-Agent': 'WayFinderApp/Final' } });
        
        if (!geoRes.data || geoRes.data.length === 0) throw new Error("Città non trovata");

        const lat = parseFloat(geoRes.data[0].lat);
        const lon = parseFloat(geoRes.data[0].lon);
        const radius = 8000; // 8km
        
        // Query Overpass massiva
        const query = `
            [out:json][timeout:90];
            (
              nwr["historic"](around:${radius},${lat},${lon});
              nwr["tourism"~"attraction|museum|viewpoint"](around:${radius},${lat},${lon});
              nwr["amenity"~"restaurant|cafe|ice_cream|fast_food|bar|pub|nightclub"](around:${radius},${lat},${lon});
              nwr["leisure"~"park|garden"](around:${radius},${lat},${lon});
            );
            out center; 
        `;

        const placesRes = await axios.post('https://overpass-api.de/api/interpreter', query, { maxContentLength: Infinity, maxBodyLength: Infinity });
        
        // Buckets per garantire varietà
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

                const placeObj = {
                    id: item.id,
                    name: item.tags.name,
                    category: cat,
                    lat: itemLat,
                    lng: itemLon,
                    description: item.tags.description || "",
                    score: score
                };
                if (buckets[cat]) buckets[cat].push(placeObj);
            });
        }

        // Unione bilanciata
        let finalSelection = [];
        const QUOTAS = { 'Cultura': 150, 'Attrazione': 100, 'Cibo': 200, 'Party': 150, 'Relax': 80 };

        Object.keys(buckets).forEach(cat => {
            buckets[cat].sort((a, b) => b.score - a.score);
            finalSelection = finalSelection.concat(buckets[cat].slice(0, QUOTAS[cat]));
        });

        res.json({ success: true, destinationCoords: { lat, lon }, places: finalSelection });

    } catch (error) {
        console.error("ERRORE SERVER:", error.message);
        res.json({ success: false, message: "Errore recupero dati." });
    }
});

// API RICERCA SPECIFICA ONLINE (Per trovare cose non in lista)
app.post('/api/search-specific', async (req, res) => {
    const { query, lat, lon } = req.body;
    if(!query || !lat) return res.json({ success: false });

    console.log(`🔎 Ricerca Specifica: ${query}`);
    try {
        // Cerca per nome (case insensitive) in un raggio ampio (50km)
        const overpassQuery = `
            [out:json][timeout:25];
            (
              nwr["name"~"${query}",i](around:50000,${lat},${lon});
            );
            out center;
        `;
        const resp = await axios.post('https://overpass-api.de/api/interpreter', overpassQuery);
        
        const results = resp.data.elements.map(item => {
            const itemLat = item.lat || (item.center ? item.center.lat : null);
            const itemLon = item.lon || (item.center ? item.center.lon : null);
            if(!item.tags || !item.tags.name || !itemLat) return null;
            
            return {
                id: item.id, 
                name: item.tags.name, 
                category: mapCategory(item.tags),
                lat: itemLat, 
                lng: itemLon, 
                description: "Risultato Ricerca Online", 
                score: 2000 // Score altissimo per mostrarlo in cima
            };
        }).filter(p => p !== null);

        res.json({ success: true, places: results });
    } catch(e) { 
        console.error(e);
        res.json({ success: false }); 
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server attivo su http://localhost:${PORT}`);
});