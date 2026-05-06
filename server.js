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
        const { day, month, year } = req.query;
        const now = new Date();

        // Query မှ ပါလာလျှင် သုံးမည်၊ မပါလျှင် လက်ရှိ နေ့/လ/နှစ် ကို သုံးမည်
        const selectedDay = day ? parseInt(day) : null; 
        const selectedMonth = month ? parseInt(month) : now.getMonth() + 1;
        const selectedYear = year ? parseInt(year) : now.getFullYear();

        let startDate, endDate;

        if (selectedDay) {
            // သတ်မှတ်ထားသော "ရက်" တစ်ရက်တည်းအတွက် Filter
            startDate = new Date(selectedYear, selectedMonth - 1, selectedDay, 0, 0, 0);
            endDate = new Date(selectedYear, selectedMonth - 1, selectedDay, 23, 59, 59);
        } else {
            // တစ်လလုံးစာအတွက် Filter
            startDate = new Date(selectedYear, selectedMonth - 1, 1);
            endDate = new Date(selectedYear, selectedMonth, 0, 23, 59, 59);
        }

        const filter = { 
            user: req.user._id, 
            date: { $gte: startDate, $lte: endDate } 
        };

        // စုစုပေါင်း ဝင်ငွေ/ထွက်ငွေ တွက်ချက်ခြင်း
        const totals = await Transaction.aggregate([
            { $match: filter },
            { $group: { _id: "$type", total: { $sum: "$amount" } } }
        ]);

        let totalIncome = 0, totalExpense = 0;
        totals.forEach(t => {
            // Case-sensitive ဖြစ်နိုင်သဖြင့် toLowerCase() ဖြင့် စစ်ဆေးခြင်း
            if (t._id.toLowerCase() === 'income') totalIncome = t.total;
            if (t._id.toLowerCase() === 'expense') totalExpense = t.total;
        });

        // စာရင်းဇယားများကို ရက်စွဲအလိုက် အစဉ်လိုက်ထုတ်ယူခြင်း
        const reportData = await Transaction.find(filter).sort({ date: -1 });

        res.render('reports', { 
            totalIncome, 
            totalExpense, 
            reportData, 
            selectedDay, // Frontend selection အတွက် ထည့်ပေးရန်လိုအပ်
            selectedMonth, 
            selectedYear, 
            page: 'reports' 
        });
    } catch (err) { 
        res.status(500).send("Reports Error: " + err.message); 
    }
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

// [E] Update Transaction - လက်ရှိစာရင်းကို ပြင်ဆင်ခြင်း
app.post('/transactions/update/:id', isLoggedIn, async (req, res) => {
    try {
        const { title, amount, type, date } = req.body;
        
        await Transaction.findOneAndUpdate(
            { _id: req.params.id, user: req.user._id },
            { title, amount, type, date },
            { new: true }
        );

        // Reports ကို ပြန်သွားရန်
        res.redirect('/reports'); 
    } catch (err) {
        res.status(500).send("Error updating transaction: " + err.message);
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
        const userId = "W-" + Math.floor(Math.random() * 1000000);
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);

        await User.create({ username, password: hashedPassword, userId: userId });

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

// Settings Page
app.get('/settings', (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    res.render('settings', { user: req.user, page: 'settings', message: null });
});

// Password Reset
app.post('/settings/update-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    try {
        const user = await User.findById(req.user._id);
        
        // Check current password
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.render('settings', { 
                user: req.user, page: 'settings', 
                message: { type: 'danger', text: 'လက်ရှိ Password မှားယွင်းနေပါသည်။' } 
            });
        }

        // Create New Password with Hash
        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

        res.render('settings', { 
            user: req.user, page: 'settings', 
            message: { type: 'success', text: 'Change Password Successfully!' } 
        });
    } catch (err) {
        res.status(500).send("Error updating settings");
    }
});

// Profile Information (Username) Update လုပ်ခြင်း
app.post('/settings/update-profile', async (req, res) => {
    const { username } = req.body;
    try {
        // လက်ရှိ Login ဝင်ထားတဲ့ User ကို ရှာပြီး Username အသစ်လဲခြင်း
        await User.findByIdAndUpdate(req.user._id, { username: username });

        // Update ဖြစ်သွားတဲ့ အချက်အလက်သစ်နဲ့အတူ Page ကို ပြန်ပြခြင်း
        res.render('settings', { 
            user: { ...req.user, username: username }, // UI မှာ ချက်ချင်းပြောင်းလဲသွားစေရန်
            page: 'settings', 
            message: { type: 'success', text: 'Profile အချက်အလက်များကို အောင်မြင်စွာ ပြောင်းလဲပြီးပါပြီ။' } 
        });
    } catch (err) {
        console.error(err);
        res.render('settings', { 
            user: req.user, page: 'settings', 
            message: { type: 'danger', text: 'အချက်အလက်ပြင်ဆင်မှု မအောင်မြင်ပါ။' } 
        });
    }
});

// app.listen(3000, () => console.log('Server running on http://localhost:3000'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
