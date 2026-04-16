require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');

// Models
const Transaction = require('./models/Transaction');
const User = require('./models/User'); // User Model အသစ်လိုအပ်ပါသည်

const app = express();
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 1. Database Connection
mongoose.connect(process.env.MONGO_URI);

// 2. Session Configuration
app.use(session({
    secret: 'my_wallet_secret_key',
    resave: false,
    saveUninitialized: false
}));

// 3. Passport Configuration
app.use(passport.initialize());
app.use(passport.session());

passport.use(new LocalStrategy(async (username, password, done) => {
    try {
        const user = await User.findOne({ username });
        if (!user) return done(null, false, { message: 'User not found' });
        
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return done(null, false, { message: 'Incorrect password' });
        
        return done(null, user);
    } catch (err) { return done(err); }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    const user = await User.findById(id);
    done(null, user);
});

// Middleware to check if user is logged in
function isLoggedIn(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

// ================= Routes =================

// [A] Dashboard - ကိုယ်ပိုင်စာရင်းများသာပြရန်
app.get('/', isLoggedIn, async (req, res) => {
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    
    // Filter မှာ လက်ရှိ login ဝင်ထားသူရဲ့ ID (user: req.user._id) ကို ထည့်သွင်းသည်
    const filter = { 
        user: req.user._id, 
        date: { $gte: startDate } 
    };
    
    const transactions = await Transaction.find(filter).sort({ date: -1 }).limit(5);
    
    const totals = await Transaction.aggregate([
        { $match: filter },
        { $group: { _id: "$type", total: { $sum: "$amount" } } }
    ]);

    let income = 0, expense = 0;
    totals.forEach(t => { if(t._id === 'income') income = t.total; if(t._id === 'expense') expense = t.total; });

    const chartData = await Transaction.aggregate([
        { $match: filter },
        { $group: { 
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } }, 
            income: { $sum: { $cond: [{ $eq: ["$type", "income"] }, "$amount", 0] } },
            expense: { $sum: { $cond: [{ $eq: ["$type", "expense"] }, "$amount", 0] } }
        }},
        { $sort: { _id: 1 } }
    ]);

    res.render('index', { 
        user: req.user,
        transactions, income, expense, chartData, page: 'dashboard' 
    });
});

// [B] History - ကိုယ်ပိုင်စာရင်းအားလုံး
app.get('/history', isLoggedIn, async (req, res) => {
    try {
        const transactions = await Transaction.find({ user: req.user._id }).sort({ date: -1 });
        res.render('history', { transactions, page: 'history' });
    } catch (err) { res.status(500).send(err.message); }
});

// [C] Reports - လအလိုက် Filter (ကိုယ်ပိုင်စာရင်းများသာ)
app.get('/reports', isLoggedIn, async (req, res) => {
    try {
        const { month, year } = req.query;
        const now = new Date();
        const selectedMonth = month ? parseInt(month) : now.getMonth() + 1;
        const selectedYear = year ? parseInt(year) : now.getFullYear();

        const startDate = new Date(selectedYear, selectedMonth - 1, 1);
        const endDate = new Date(selectedYear, selectedMonth, 0, 23, 59, 59);

        const filter = { 
            user: req.user._id, 
            date: { $gte: startDate, $lte: endDate } 
        };

        const totals = await Transaction.aggregate([
            { $match: filter },
            { $group: { _id: "$type", total: { $sum: "$amount" } } }
        ]);

        let totalIncome = 0, totalExpense = 0;
        totals.forEach(t => {
            if (t._id === 'income') totalIncome = t.total;
            if (t._id === 'expense') totalExpense = t.total;
        });

        const reportData = await Transaction.find(filter).sort({ date: -1 });

        res.render('reports', { 
            totalIncome, totalExpense, reportData, selectedMonth, selectedYear, page: 'reports' 
        });
    } catch (err) { res.status(500).send("Reports Error: " + err.message); }
});

// [D] Add Transaction - User ID ပါတွဲသိမ်းရန်
app.post('/add', isLoggedIn, async (req, res) => {
    try {
        const { title, amount, type, date } = req.body;
        await Transaction.create({
            title,
            amount,
            type,
            date,
            user: req.user._id
        });
        res.redirect('/'); 
    } catch (err) {
        res.status(500).send("Error adding transaction: " + err.message);
    }
});

// ================= Auth Routes =================

app.get('/login', (req, res) => res.render('login', { page: 'login' }));
app.post('/login', passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login'
}));

app.get('/register', (req, res) => res.render('register', { page: 'register' }));
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        await User.create({ username, password: hashedPassword });
        res.redirect('/login');
    } catch (err) { res.status(500).send("Registration Error: " + err.message); }
});

app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/login'));
});

// Account Informatin
app.get('/profile', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');

    try {
        const transactions = await Transaction.find({ user: req.user._id });
        
        let totalIncome = 0;
        let totalExpense = 0;

        transactions.forEach(t => {
            if (t.type.toUpperCase() === 'INCOME') {
                totalIncome += t.amount;
            } else if (t.type.toUpperCase() === 'EXPENSE') {
                totalExpense += Math.abs(t.amount); // အကယ်၍ amount က negative (-137000) ဖြစ်နေရင် positive ပြောင်းပေါင်းဖို့ပါ
            }
        });

        res.render('profile', { 
            user: req.user, 
            page: 'profile',
            stats: {
                income: totalIncome,
                expense: totalExpense,
                balance: totalIncome - totalExpense,
                count: transactions.length
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching profile data");
    }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));