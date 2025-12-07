// NOME FILE: database.js
const sqlite3 = require('sqlite3').verbose();

// Creiamo il database su un file locale
const db = new sqlite3.Database('./wayfinder.db', (err) => {
    if (err) {
        console.error('Errore apertura database:', err.message);
    } else {
        console.log('Connesso al database SQLite.');
    }
});

// Creiamo le tabelle necessarie
db.serialize(() => {
    // Tabella Utenti
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT
    )`);

    // Tabella Viaggi
    db.run(`CREATE TABLE IF NOT EXISTS trips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        destination TEXT,
        mood TEXT,
        days INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tabella Attività (L'itinerario)
    db.run(`CREATE TABLE IF NOT EXISTS activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER,
        day_number INTEGER,
        name TEXT,
        type TEXT,
        time_slot TEXT
    )`);
});

module.exports = db;