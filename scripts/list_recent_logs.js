require('dotenv').config();
const mysql = require('mysql2/promise');

const db = mysql.createPool({
    host: (process.env.DB_HOST || '127.0.0.1').trim(),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5
});

async function main() {
    try {
        const [rows] = await db.query('SELECT id, date, scoreTitle, durationSeconds, user_id FROM logs ORDER BY id DESC LIMIT 60');
        console.log('Recent logs (latest 60):');
        for (const r of rows) {
            console.log(`id=${r.id} | date=${r.date} | title=${r.scoreTitle} | duration=${r.durationSeconds} | user_id=${r.user_id}`);
        }
        process.exit(0);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

main();
