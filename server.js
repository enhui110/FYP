require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const imgToPDF = require('images-to-pdf');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.JWT_SECRET || "your_fallback_secret_key";

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    req.setTimeout(300000);
    res.setTimeout(300000);
    next();
});

// Static
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

app.use(express.static('public'));
app.use('/uploads', express.static(uploadDir));

// DB Connection
const db = mysql.createPool({
    host: (process.env.DB_HOST || '127.0.0.1').trim(),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

// Ensure composer column
async function ensureScoresComposerColumn() {
    try {
        const [columns] = await db.query("SHOW COLUMNS FROM scores LIKE 'composer'");
        if (!columns.length) {
            await db.query(`
                ALTER TABLE scores 
                ADD COLUMN composer VARCHAR(255) 
                NOT NULL DEFAULT 'Unknown Composer'
                AFTER title
            `);
        }
    } catch (err) {
        console.error(err.message);
    }
}

// Ensure logs table
async function ensureLogsTable() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                scoreTitle VARCHAR(255) NOT NULL,
                durationSeconds INT NOT NULL,
                date DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
    } catch (err) {
        console.error(err.message);
    }
}

// Ensure group messages table
async function ensureGroupMessagesTable() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS group_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                group_id INT NOT NULL,
                user_id INT NOT NULL,
                message TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
    } catch (err) {
        console.error("Group messages table error:", err.message);
    }
}

async function ensureLogsUserIdColumn() {
    try {
        const [columns] = await db.query('SHOW COLUMNS FROM logs');
        const hasUserId = columns.some(column => column.Field === 'user_id');
        const hasLegacyUserId = columns.some(column => column.Field === 'userId');

        if (hasUserId) {
            return;
        }

        if (hasLegacyUserId) {
            await db.query('ALTER TABLE logs CHANGE COLUMN userId user_id INT NULL');
            return;
        }

        await db.query('ALTER TABLE logs ADD COLUMN user_id INT NULL AFTER id');
    } catch (err) {
        console.error('ensureLogsUserIdColumn error:', err.message);
    }
}

async function getLogsUserColumn() {
    try {
        const [columns] = await db.query('SHOW COLUMNS FROM logs');
        if (columns.some(column => column.Field === 'user_id')) {
            return 'user_id';
        }
        if (columns.some(column => column.Field === 'userId')) {
            return 'userId';
        }
    } catch (err) {
        console.error('getLogsUserColumn error:', err.message);
    }
    return null;
}

const logsFilePath = path.join(__dirname, 'data', 'logs.json');

function readLogsFile() {
    try {
        if (!fs.existsSync(logsFilePath)) return [];
        const raw = fs.readFileSync(logsFilePath, 'utf8');
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error('readLogsFile error:', err.message);
        return [];
    }
}

function appendLogToFile(entry) {
    const logs = readLogsFile();
    const nextId = logs.length ? Math.max(...logs.map(item => Number(item.id) || 0)) + 1 : 1;
    const newEntry = { id: nextId, ...entry };
    fs.writeFileSync(logsFilePath, JSON.stringify([newEntry, ...logs], null, 4), 'utf8');
    return newEntry;
}

function normalizeLogDate(input) {
    if (input instanceof Date && !Number.isNaN(input.getTime())) {
        return input.toISOString();
    }

    const text = String(input || '').trim();
    if (!text) return '';

    if (text.includes('T') || text.includes('-')) {
        const d = new Date(text);
        if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1970) return d.toISOString();
    }

    const m = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:,\s*(\d{1,2}):(\d{2}):(\d{2}))?$/);
    if (m) {
        const dd = m[1].padStart(2, '0');
        const mm = m[2].padStart(2, '0');
        const yyyy = m[3];
        const hh = (m[4] || '00').padStart(2, '0');
        const mi = (m[5] || '00').padStart(2, '0');
        const ss = (m[6] || '00').padStart(2, '0');
        const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
        const d = new Date(iso);
        if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1970) return d.toISOString();
    }

    return String(input || '');
}

function toMysqlDateTime(input) {
    let d = null;

    if (input instanceof Date && !isNaN(input.getTime())) {
        d = input;
    } else {
        const text = String(input || '').trim();
        if (!text) return null;

        if (text.includes('T') || text.includes('-')) {
            const parsed = new Date(text);
            if (!isNaN(parsed.getTime())) d = parsed;
        }

        if (!d) {
            const m = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:,\s*(\d{1,2}):(\d{2}):(\d{2}))?$/);
            if (m) {
                const dd = m[1].padStart(2, '0');
                const mm = m[2].padStart(2, '0');
                const yyyy = m[3];
                const hh = (m[4] || '00').padStart(2, '0');
                const mi = (m[5] || '00').padStart(2, '0');
                const ss = (m[6] || '00').padStart(2, '0');
                const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
                const parsed = new Date(iso);
                if (!isNaN(parsed.getTime())) d = parsed;
            }
        }
    }

    if (!d || isNaN(d.getTime())) return null;

    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

async function syncFileLogsToDb() {
    try {
        const userColumn = await getLogsUserColumn();
        if (!userColumn) {
            return;
        }

        const logs = readLogsFile();
        for (const log of logs) {
            const userId = Number(log.user_id ?? log.userId);
            const duration = Number(log.durationSeconds);
            const title = String(log.scoreTitle || 'Untitled Session');
            const dateTime = toMysqlDateTime(log.date);

            if (!userId || !Number.isFinite(duration) || !dateTime) continue;

            const [exists] = await db.query(
                `SELECT id FROM logs WHERE \`${userColumn}\`=? AND scoreTitle=? AND durationSeconds=? AND date=? LIMIT 1`,
                [userId, title, duration, dateTime]
            );

            if (!exists.length) {
                await db.query(
                    `INSERT INTO logs (\`${userColumn}\`, scoreTitle, durationSeconds, date) VALUES (?,?,?,?)`,
                    [userId, title, duration, dateTime]
                );
            }
        }
    } catch (err) {
        console.error('syncFileLogsToDb error:', err.message);
    }
}

async function initializeDatabase() {
    await ensureScoresComposerColumn();
    await ensureLogsTable();
    await ensureLogsUserIdColumn();
    await ensureGroupMessagesTable(); 
    await syncFileLogsToDb();
    await fixMayJuneSwap();
    await fixNullLogDates();
}

initializeDatabase();

// Fix specific month/day swap issue
async function fixMayJuneSwap() {
    try {
        const [cols] = await db.query("SHOW COLUMNS FROM logs");
        const hasUserId = cols.some(c => c.Field === 'user_id');
        const hasLegacy = cols.some(c => c.Field === 'userId');
        let userCond = '';
        if (hasUserId) userCond = 'user_id=1';
        else if (hasLegacy) userCond = 'userId=1';
        else return;

        const q = `SELECT id, date FROM logs WHERE ${userCond} AND id>=22 AND DATE(date)='2026-06-05'`;
        const [rows] = await db.query(q);
        if (!rows.length) return;

        const backupPath = path.join(__dirname, 'data', `fix_may_june_backup_${Date.now()}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(rows, null, 4), 'utf8');

        for (const r of rows) {
            await db.query(
                "UPDATE logs SET date = STR_TO_DATE(CONCAT(YEAR(date),'-',LPAD(DAY(date),2,'0'),'-',LPAD(MONTH(date),2,'0'),' ',DATE_FORMAT(date,'%H:%i:%s')), '%Y-%m-%d %H:%i:%s') WHERE id=?",
                [r.id]
            );
        }
    } catch (err) {
        console.error('fixMayJuneSwap error:', err.message);
    }
}

async function fixNullLogDates() {
    try {
        const [rows] = await db.query("SELECT id, user_id, scoreTitle, durationSeconds FROM logs WHERE date IS NULL LIMIT 1000");
        if (!rows.length) return;
        const backupPath = path.join(__dirname, 'data', `null_date_backup_${Date.now()}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(rows, null, 4), 'utf8');

        for (const r of rows) {
            await db.query('UPDATE logs SET date=NOW() WHERE id=?', [r.id]);
        }
    } catch (err) {
        console.error('fixNullLogDates error:', err.message);
    }
}

// AUTH GUARD MIDDLEWARE
const authGuard = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'No token provided' });
    }

    try {
        req.user = jwt.verify(token, SECRET_KEY);
        next();
    } catch (err) {
        return res.status(403).json({ success: false, message: 'Invalid token' });
    }
};

// MULTER SETUP
const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const base = path.basename(file.originalname, ext)
            .replace(/[^a-zA-Z0-9]/g, '_');

        cb(null, `${Date.now()}-${base}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 1024 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowed.includes(ext)) return cb(new Error("Invalid file type"));
        cb(null, true);
    }
});

// SIGNUP
app.post('/api/signup', async (req, res) => {
    const { name, email, password } = req.body;

    try {
        const [existing] = await db.query(
            'SELECT id FROM users WHERE email=?',
            [email]
        );

        if (existing.length) {
            return res.status(400).json({ message: "Email already exists" });
        }

        const hash = await bcrypt.hash(password, 10);

        await db.query(
            'INSERT INTO users (name,email,password) VALUES (?,?,?)',
            [name, email, hash]
        );

        res.json({ success: true });

    } catch {
        res.status(500).json({ message: "Database error" });
    }
});

// LOGIN
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const [users] = await db.query(
            'SELECT * FROM users WHERE email=?',
            [email]
        );

        if (!users.length) {
            return res.status(401).json({ message: "User not found" });
        }

        const user = users[0];
        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            return res.status(401).json({ message: "Wrong password" });
        }

        const token = jwt.sign(
            { id: user.id, name: user.name },
            SECRET_KEY,
            { expiresIn: '12h' }
        );

        res.json({
            success: true,
            token,
            userName: user.name,
            userId: user.id
        });

    } catch {
        res.status(500).json({ message: "Database error" });
    }
});

// PUBLIC FORGOT PASSWORD
app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email, newPassword } = req.body;

        const [users] = await db.query('SELECT id FROM users WHERE email=?', [email]);
        if (!users.length) {
            return res.status(404).json({ success: false, message: "Email not found in our system." });
        }

        const hash = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password=? WHERE email=?', [hash, email]);

        res.json({ success: true, message: "Password reset successfully! You can now login." });
    } catch (err) {
        console.error("Reset password error: ", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PROFILE FORGOT PASSWORD 
app.post('/api/profile-forgot-password', authGuard, async (req, res) => {
    try {
        const { email, newPassword } = req.body;
        const userId = req.user.id;

        const [users] = await db.query('SELECT email FROM users WHERE id=?', [userId]);
        
        if (!users.length) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        if (users[0].email !== email.trim()) {
            return res.status(403).json({ success: false, message: "The email does not match your account." });
        }

        const hash = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password=? WHERE id=?', [hash, userId]);

        res.json({ success: true, message: "Password reset successfully!" });
    } catch (err) {
        console.error("Profile reset password error: ", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// 1. CHECK IF USERNAME IS AVAILABLE
app.post('/api/users/check-username', authGuard, async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) {
            return res.json({ isAvailable: false });
        }

        const userId = req.user.id;
        const [existing] = await db.query(
            'SELECT id FROM users WHERE name = ? AND id != ?',
            [username, userId]
        );

        if (existing.length > 0) {
            res.json({ isAvailable: false });
        } else {
            res.json({ isAvailable: true });
        }
    } catch (err) {
        console.error('Check username error:', err.message);
        res.status(500).json({ isAvailable: false });
    }
});

// 2. VERIFY OLD PASSWORD
app.post('/api/users/verify-password', authGuard, async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) {
            return res.json({ isValid: false });
        }

        const [users] = await db.query('SELECT password FROM users WHERE id=?', [req.user.id]);
        if (!users.length) {
            return res.json({ isValid: false });
        }

        const match = await bcrypt.compare(password, users[0].password);
        res.json({ isValid: match });

    } catch (err) {
        console.error('Verify password error:', err.message);
        res.status(500).json({ isValid: false });
    }
});

// 3. UPDATE USER PROFILE (NAME & PASSWORD)
app.put('/api/users/update', authGuard, async (req, res) => {    
    try {
        const userId = req.user.id;
        const { username, password, oldPassword } = req.body; 

        if (!username && !password) {
            return res.status(400).json({ message: "No data provided for update." });
        }

        if (username) {
            const [existing] = await db.query(
                'SELECT id FROM users WHERE name = ? AND id != ?',
                [username, userId]
            );

            if (existing.length > 0) {
                return res.status(409).json({ 
                    message: "This username is already taken. Please choose another one." 
                });
            }
        }

        if (password) {
            if (!oldPassword) {
                return res.status(400).json({ message: "Old password is required to change password." });
            }
            const [users] = await db.query('SELECT password FROM users WHERE id=?', [userId]);
            const match = await bcrypt.compare(oldPassword, users[0].password);
            if (!match) {
                return res.status(401).json({ message: "Incorrect old password." });
            }
        }

        let updateQuery = "UPDATE users SET ";
        let queryParams = [];
        let setClauses = [];

        if (username) {
            setClauses.push("name = ?");
            queryParams.push(username);
        }

        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            setClauses.push("password = ?");
            queryParams.push(hashedPassword);
        }

        updateQuery += setClauses.join(", ") + " WHERE id = ?";
        queryParams.push(userId);

        const [result] = await db.query(updateQuery, queryParams);

        if (result.affectedRows === 0) {
            return res.status(500).json({ message: "Failed to update profile." });
        }

        res.json({ success: true, message: "Profile updated successfully!" });

    } catch (err) {
        console.error("[USER API] Database error during update: ", err.message);
        res.status(500).json({ message: "Internal server error." });
    }
});

// ==========================================
// SCORES APIs
// ==========================================

// GET ALL
app.get('/api/scores', async (req, res) => {
    const [rows] = await db.query('SELECT * FROM scores ORDER BY id DESC');
    res.json(rows);
});

// GET ONE
app.get('/api/scores/:id', async (req, res) => {
    const [rows] = await db.query(
        'SELECT * FROM scores WHERE id=?',
        [req.params.id]
    );

    if (!rows.length) {
        return res.status(404).json({ message: "Not found" });
    }

    res.json(rows[0]);
});

// UPLOAD
app.post('/api/upload', authGuard, upload.single('scoreFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: "No file provided" });
        }

        const composer = req.body.composer || 'Unknown Composer';
        let fileName = req.file.filename;
        const ext = path.extname(fileName);

        if (['.jpg', '.jpeg', '.png'].includes(ext)) {
            const pdfName = fileName.replace(ext, '.pdf');
            await imgToPDF([req.file.path], path.join(uploadDir, pdfName));
            fileName = pdfName;
        }

        await db.query(
            `INSERT INTO scores 
            (title, composer, instrument, difficulty, uploader, uploader_id, url)
            VALUES (?,?,?,?,?,?,?)`,
            [
                req.body.title,
                composer,
                req.body.instrument,
                req.body.difficulty,
                req.user.name,
                req.user.id,
                `uploads/${fileName}`
            ]
        );

        res.json({ success: true });

    } catch (err) {
        console.error("[UPLOAD API] Database or file processing error: ", err.message);
        res.status(500).json({ message: err.message });
    }
});

// DELETE (SECURE)
app.delete('/api/scores/:id', authGuard, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT id, uploader, uploader_id FROM scores WHERE id=?',
            [req.params.id]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: 'File not found.'
            });
        }

        const score = rows[0];
        const ownerId = score.uploader_id;
        let isOwner = false;

        if (ownerId != null) {
            isOwner = Number(ownerId) === Number(req.user.id);
        } else {
            const [matchedUsers] = await db.query(
                'SELECT id FROM users WHERE name=? LIMIT 2',
                [score.uploader]
            );

            isOwner = matchedUsers.length === 1 && Number(matchedUsers[0].id) === Number(req.user.id);
        }

        if (!isOwner) {
            return res.status(403).json({
                success: false,
                message: 'This is not your file. You cannot delete it.'
            });
        }

        const [result] = await db.query(
            'DELETE FROM scores WHERE id=?',
            [req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(500).json({
                success: false,
                message: 'Delete failed. Please try again.'
            });
        }

        res.json({ success: true, message: 'Deleted successfully' });

    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET ALL LOGS FOR USER
app.get('/api/logs', authGuard, async (req, res) => {
    try {
        const userColumn = await getLogsUserColumn();
        if (!userColumn) {
            return res.json([]);
        }

        const [rows] = await db.query(
            `SELECT id, \`${userColumn}\` AS user_id, scoreTitle, durationSeconds, date FROM logs WHERE \`${userColumn}\`=? ORDER BY date DESC`,
            [req.user.id]
        );

        if (rows.length) {
            const dbLogs = rows.map(log => ({
                id: log.id,
                user_id: Number(log.user_id),
                scoreTitle: log.scoreTitle,
                durationSeconds: Number(log.durationSeconds) || 0,
                date: normalizeLogDate(log.date)
            }));
            return res.json(dbLogs);
        }

        const allLogs = readLogsFile();
        const userId = Number(req.user.id);
        const fileLogs = allLogs
            .filter(log => Number(log.user_id ?? log.userId) === userId)
            .map(log => ({
                ...log,
                user_id: Number(log.user_id ?? log.userId),
                date: normalizeLogDate(log.date)
            }));
        res.json(fileLogs);
    } catch (err) {
        console.error('GET /api/logs db error:', err.message);
        const allLogs = readLogsFile();
        const userId = Number(req.user.id);
        const fileLogs = allLogs
            .filter(log => Number(log.user_id ?? log.userId) === userId)
            .map(log => ({
                ...log,
                user_id: Number(log.user_id ?? log.userId),
                date: normalizeLogDate(log.date)
            }));
        res.json(fileLogs);
    }
});

// POST NEW LOG 
app.post('/api/logs', authGuard, async (req, res) => {
    try {
        const { scoreTitle, durationSeconds, durationMinutes } = req.body;
        
        if (!scoreTitle || (durationSeconds === undefined && durationMinutes === undefined)) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        const minutesValue = Number(durationMinutes);
        const secondsValue = Number(durationSeconds);
        const storedSeconds = Number.isFinite(minutesValue) && minutesValue > 0
            ? Math.max(60, Math.round(minutesValue) * 60)
            : (Number.isFinite(secondsValue) ? Math.max(0, Math.round(secondsValue)) : 0);

        let dbWriteOk = false;
        try {
            const nowMysql = toMysqlDateTime(new Date().toISOString());
            await db.query(
                'INSERT INTO logs (user_id, scoreTitle, durationSeconds, date) VALUES (?, ?, ?, ?)',
                [req.user.id, scoreTitle, storedSeconds, nowMysql]
            );
            dbWriteOk = true;
        } catch (dbErr) {
            console.error('[LOG API] Failed to save to MySQL. Reason: ', dbErr.message); 
        }

        appendLogToFile({
            user_id: Number(req.user.id),
            scoreTitle,
            durationSeconds: storedSeconds,
            date: new Date().toISOString()
        });

        if (dbWriteOk) {
            return res.json({ success: true });
        }

        res.status(202).json({ success: true, warning: 'Saved to file only. DB unavailable.' });
    } catch (err) {
        console.error('[LOG API] Critical system error: ', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ==========================================
// GROUPS APIs
// ==========================================

// 1. CREATE GROUP
app.post('/api/groups', authGuard, async (req, res) => {
    try {
        const { groupName } = req.body;
        const userId = req.user.id;
        
        if (!groupName) return res.status(400).json({ success: false, message: "Group name is required" });

        const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();

        const [result] = await db.query(
            'INSERT INTO \`groups\` (group_name, invite_code, creator_id) VALUES (?, ?, ?)',
            [groupName, inviteCode, userId]
        );
        const groupId = result.insertId;

        await db.query(
            'INSERT INTO group_members (group_id, user_id) VALUES (?, ?)',
            [groupId, userId]
        );

        res.json({ success: true, groupId, inviteCode, message: "Group created successfully!" });
    } catch (err) {
        console.error('Create group error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. JOIN GROUP
app.post('/api/groups/join', authGuard, async (req, res) => {
    try {
        const { inviteCode } = req.body;
        const userId = req.user.id;

        const [groups] = await db.query('SELECT * FROM \`groups\` WHERE invite_code = ?', [inviteCode.trim()]);
        
        if (groups.length === 0) return res.status(404).json({ success: false, message: "Invalid invite code" });

        const group = groups[0];

        const [existing] = await db.query(
            'SELECT * FROM group_members WHERE group_id = ? AND user_id = ?',
            [group.id, userId]
        );
        
        if (existing.length > 0) return res.status(400).json({ success: false, message: "You are already in this group" });

        await db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [group.id, userId]);

        res.json({ success: true, message: "Joined group successfully!", groupName: group.group_name });
    } catch (err) {
        console.error('Join group error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. GET MY GROUPS
app.get('/api/my-groups', authGuard, async (req, res) => {
    try {
        const userId = req.user.id;
        const [rows] = await db.query(`
            SELECT g.* FROM \`groups\` g
            JOIN group_members gm ON g.id = gm.group_id
            WHERE gm.user_id = ?
        `, [userId]);
        res.json(rows);
    } catch (err) {
        console.error('Get my groups error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 4. SHARE SCORE TO GROUP
app.post('/api/groups/:groupId/scores', authGuard, async (req, res) => {
    try {
        const { groupId } = req.params;
        const { scoreId } = req.body;
        const userId = req.user.id;

        const [member] = await db.query('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
        if (member.length === 0) return res.status(403).json({ success: false, message: "You are not a member of this group" });

        const [existing] = await db.query('SELECT * FROM group_scores WHERE group_id = ? AND score_id = ?', [groupId, scoreId]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: "Score already shared in this group" });

        await db.query('INSERT INTO group_scores (group_id, score_id, shared_by) VALUES (?, ?, ?)', [groupId, scoreId, userId]);

        res.json({ success: true, message: "Score shared successfully!" });
    } catch (err) {
        console.error('Share score error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 5. GET SCORES IN A GROUP
app.get('/api/groups/:groupId/scores', authGuard, async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.user.id;

        const [member] = await db.query('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
        if (member.length === 0) return res.status(403).json({ success: false, message: "Access denied" });

        const [scores] = await db.query(`
            SELECT s.*, u.name as uploader_name, gs.shared_at 
            FROM group_scores gs
            JOIN scores s ON gs.score_id = s.id
            JOIN users u ON gs.shared_by = u.id
            WHERE gs.group_id = ?
            ORDER BY gs.shared_at DESC
        `, [groupId]);

        res.json(scores);
    } catch (err) {
        console.error('Get group scores error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 6. LEAVE GROUP
app.delete('/api/groups/:groupId/leave', authGuard, async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.user.id;

        const [member] = await db.query('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
        if (member.length === 0) {
            return res.status(400).json({ success: false, message: "You are not a member of this group." });
        }

        await db.query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);

        res.json({ success: true, message: "You have successfully left the group." });
    } catch (err) {
        console.error('Leave group error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GROUP CHAT APIs
app.get('/api/groups/:groupId/messages', authGuard, async (req, res) => {
    try {
        const { groupId } = req.params;
        const [member] = await db.query('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.user.id]);
        if (member.length === 0) return res.status(403).json({ success: false, message: "Access denied" });

        const [messages] = await db.query(`
            SELECT gm.id, gm.message, gm.created_at, u.name as sender_name, u.id as sender_id
            FROM group_messages gm
            JOIN users u ON gm.user_id = u.id
            WHERE gm.group_id = ?
            ORDER BY gm.created_at ASC
        `, [groupId]);

        res.json(messages);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/groups/:groupId/messages', authGuard, async (req, res) => {
    try {
        const { groupId } = req.params;
        const { message } = req.body;
        if (!message || !message.trim()) return res.status(400).json({ success: false, message: "Message cannot be empty" });

        const [member] = await db.query('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, req.user.id]);
        if (member.length === 0) return res.status(403).json({ success: false, message: "Access denied" });

        await db.query('INSERT INTO group_messages (group_id, user_id, message) VALUES (?, ?, ?)', [groupId, req.user.id, message.trim()]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ================= START =================
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});