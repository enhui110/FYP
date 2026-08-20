require('dotenv').config();
const fs = require('fs');
const path = require('path');
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
        // Detect which user column exists
        const [cols] = await db.query("SHOW COLUMNS FROM logs");
        const hasUserId = cols.some(c => c.Field === 'user_id');
        const hasLegacy = cols.some(c => c.Field === 'userId');
        let whereUser = '';
        if (hasUserId) whereUser = 'user_id=1';
        else if (hasLegacy) whereUser = 'userId=1';
        else whereUser = '1=1';

        // Select rows that currently show 2026-06-05 for user 1 and id >= 22
        const q = `SELECT * FROM logs WHERE ${whereUser} AND id>=22 AND DATE(date)='2026-06-05'`;
        const [rows] = await db.query(q);

        if (!rows.length) {
            console.log('No matching rows found. Nothing to change.');
            process.exit(0);
        }

        const backupPath = path.join(__dirname, '..', 'data', `fix_may_june_backup_${Date.now()}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(rows, null, 4), 'utf8');
        console.log(`Backed up ${rows.length} rows to ${backupPath}`);

        for (const r of rows) {
            const id = r.id;
            // Swap day and month in the date value by reconstructing from components
            // New date will use DAY(date) as month and MONTH(date) as day
            const update = `UPDATE logs SET date = STR_TO_DATE(CONCAT(YEAR(date),'-',LPAD(DAY(date),2,'0'),'-',LPAD(MONTH(date),2,'0'),' ',DATE_FORMAT(date,'%H:%i:%s')), '%Y-%m-%d %H:%i:%s') WHERE id=?`;
            await db.query(update, [id]);
            console.log(`Updated id=${id}`);
        }

        console.log('Finished updates. Please restart server and refresh dashboard.');
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

main();
