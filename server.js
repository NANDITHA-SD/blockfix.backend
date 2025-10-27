// server_final.js
// Full backend with complaint, votes, funds, vendor actions, fund-pool, proof upload.
// Start with: npm install express mongoose cors multer bcryptjs jsonwebtoken
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 5000;
const renderURL = process.env.RENDER_EXTERNAL_URL;





app.use(express.json());
app.use(cors({ origin: '*', credentials: true }));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
  console.log('Created uploads folder.');
}

// Multer setup
//const storage = multer.memoryStorage();
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});


const upload = multer({ storage });

// MongoDB connection
const mongoURI = "mongodb+srv://sdnanditha5_db_user:g2Dhk4rI1HGeILMu@cluster0.kklirez.mongodb.net/blockfixDB?retryWrites=true&w=majority";
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=>console.log("MongoDB connected successfully!"))
  .catch(err=>console.error("MongoDB connection error:", err));

// ===== Schemas & Models =====

// User
const userSchema = new mongoose.Schema({
  name: String,
  username: String,
  password: String,
  role: String,
  regNo: String,
  code: String
});
const User = mongoose.model('User', userSchema);

// Complaint
const complaintSchema = new mongoose.Schema({
  // keep subject alias for frontend compatibility
  subject: String,
  title: String,
  description: String,
  category: String,
  location: String,
  photo: String,         // original student photo
  vendorProof: String,   // vendor proof photo (data path)
  status: { type: String, default: "Pending" },
  regNo: String,
  name: String,          // student name
  sensitive: { type: Boolean, default: false },
  votes: { type: Number, default: 0 },
  votedBy: { type: [String], default: [] }, // regNos
  adminSetAmount: { type: Number, default: 0 },
  vendorAssigned: { type: String, default: null }, // vendor code
  solvedByVendor: { type: Boolean, default: false },
  studentConfirmed: { type: Boolean, default: false },
  fundsReleased: { type: Boolean, default: false },
  vendorNote: String,
  vendorName: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
complaintSchema.pre('save', function(next){ this.updatedAt = Date.now(); next(); });
const Complaint = mongoose.model('Complaint', complaintSchema);

// Vote (separate collection for audit)
const voteSchema = new mongoose.Schema({
  complaintId: String,
  regNo: String,
  date: { type: Date, default: Date.now }
});
const Vote = mongoose.model('Vote', voteSchema);

// Fund / Transaction
const fundSchema = new mongoose.Schema({
  complaintId: String,
  amount: Number,
  status: { type: String, default: 'Requested' }, // Requested, Approved, Released
  note: String,
  date: { type: Date, default: Date.now }
});
const Fund = mongoose.model('Fund', fundSchema);

// FundPool (single doc)
const fundPoolSchema = new mongoose.Schema({
  total: { type: Number, default: 20000 },
  history: { type: Array, default: [] }
});
const FundPool = mongoose.model('FundPool', fundPoolSchema);

// ===== Predefined Users (insert if empty) =====
const predefinedUsers = [
  { name: "Student One", username: "student1", password: "1111", role: "student", regNo: "S001" },
  { name: "Student Two", username: "student2", password: "2222", role: "student", regNo: "S002" },
  { name: "Student Three", username: "student3", password: "3333", role: "student", regNo: "S003" },
  { name: "Student Four", username: "student4", password: "4444", role: "student", regNo: "S004" },
  { name: "Admin", username: "admin1", password: "admin123", role: "admin" },
  { name: "Vendor One", username: "vendor1", password: "5555", role: "vendor", code: "V001" },
  { name: "Vendor Two", username: "vendor2", password: "6666", role: "vendor", code: "V002" },
  { name: "Vendor Three", username: "vendor3", password: "7777", role: "vendor", code: "V003" }
];

(async() => {
  try {
    const us = await User.find();
    if (!us.length) {
      console.log("Inserting predefined users...");
      for (let u of predefinedUsers) await new User(u).save();
      console.log("Predefined users inserted.");
    } else {
      console.log(`Users present: ${us.length}`);
    }
    // ensure fundPool exists
    const pool = await FundPool.findOne();
    if (!pool) {
      await new FundPool({ total: 20000, history: [] }).save();
      console.log('FundPool initialized with ₹20,000');
    }
  } catch (err) {
    console.error('Init error:', err);
  }
})();

// ===== Routes =====

app.get('/', (req, res) => res.send('BlockFix Cloud Backend is running!'));

// Login (kept simple — frontend uses local login but this is useful)
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if(!username || !password) return res.status(400).json({ message: 'Required' });
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ message: 'User not found' });
    if (user.password !== password) return res.status(400).json({ message: 'Invalid credentials' });
    res.json({ message: 'Login successful', user: { username: user.username, role: user.role, name: user.name, regNo: user.regNo, code: user.code } });
  } catch (err) {
    console.error(err); res.status(500).json({ message: 'Server error' });
  }
});

// Get all users (debug)
app.get('/api/check-users', async (req, res) => {
  const users = await User.find();
  res.json(users);
});

// POST new complaint (student submission)
// expects: subject OR title, description, category, location, name, regNo; optionally photo file 'photo'
app.post('/api/complaints', upload.single('photo'), async (req, res) => {
  try {
    const { subject, title, description, category, location, name, regNo } = req.body;
    let photoPath = '';
    if (req.file) photoPath = '/uploads/' + req.file.filename;

    // create complaintId like CMPxxxx
    const base = (Date.now() % 1000000);
    const complaintId = 'CMP' + (1000 + Math.floor(base % 9000));

    const comp = new Complaint({
      subject: subject || title || '(no subject)',
      title: subject || title || '(no subject)',
      description,
      category,
      location,
      photo: photoPath,
      name: name || '',
      regNo: regNo || '',
      status: 'Pending',
      votes: 0,
      votedBy: [],
      adminSetAmount: 0
    });
    const saved = await comp.save();

    // Return object with id field expected by frontend (frontend expects c.id)
    const ret = saved.toObject();
    ret.id = ret._id.toString();
    res.json(ret);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get all complaints
app.get('/api/complaints', async (req, res) => {
  try {
    const complaints = await Complaint.find().sort({ createdAt: -1 });
    // Map _id to id, subject to subject (frontend expects subject & description & file/photo)
    const mapped = complaints.map(c => {
      const o = c.toObject();
      o.id = o._id.toString();
      o.file = o.photo; // for compatibility with frontend's 'file' references
      return o;
    });
    res.json(mapped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT update complaint general fields (status, adminSetAmount, vendorAssigned, vendorName, vendorNote, sensitive)
app.put('/api/complaints/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};
    updates.updatedAt = Date.now();
    const comp = await Complaint.findByIdAndUpdate(id, updates, { new: true });
    if (!comp) return res.status(404).json({ message: 'Complaint not found' });
    const o = comp.toObject(); o.id = o._id.toString(); o.file = o.photo;
    res.json(o);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// POST vendor proof (multipart form) -> save vendorProof, vendorNote, solvedByVendor true, status
app.post('/api/complaints/:id/proof', upload.single('proof'), async (req, res) => {
  try {
    const { id } = req.params;
    const { vendorNote, vendorName } = req.body;
    if (!req.file) return res.status(400).json({ message: 'No proof file' });
    const proofPath = '/uploads/' + req.file.filename;
    const comp = await Complaint.findByIdAndUpdate(id, {
      vendorProof: proofPath,
      vendorNote: vendorNote || '',
      vendorName: vendorName || '',
      solvedByVendor: true,
      status: 'Solved by Vendor',
      updatedAt: Date.now()
    }, { new: true });
    if (!comp) return res.status(404).json({ message: 'Complaint not found' });
    res.json({ message: 'Proof uploaded', complaint: comp });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// POST vote for complaint (body: regNo)
app.post('/api/complaints/:id/vote', async (req, res) => {
  try {
    const { id } = req.params;
    const { regNo } = req.body;
    if (!regNo) return res.status(400).json({ message: 'regNo required' });

    const comp = await Complaint.findById(id);
    if (!comp) return res.status(404).json({ message: 'Complaint not found' });

    if (comp.votedBy && comp.votedBy.includes(regNo)) {
      return res.status(400).json({ message: 'Already voted' });
    }
    comp.votedBy = comp.votedBy || [];
    comp.votedBy.push(regNo);
    comp.votes = comp.votedBy.length;
    // If votes reaches threshold, update status (frontend expects this)
    if (comp.votes >= 3 && !comp.sensitive) comp.status = 'Verified by Community';
    await comp.save();

    // Record vote in Vote collection
    await new Vote({ complaintId: id, regNo }).save();

    res.json({ message: 'Vote recorded', votes: comp.votes, complaint: comp });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// POST create a fund request (or auto create when adminSetAmount assigned) -> body: complaintId, amount, note
app.post('/api/funds', async (req, res) => {
  try {
    const { complaintId, amount, note } = req.body;
    if (!complaintId || !amount) return res.status(400).json({ message: 'complaintId and amount required' });
    const fund = await new Fund({ complaintId, amount: Number(amount), note: note || '' }).save();
    res.json(fund);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// GET funds
app.get('/api/funds', async (req, res) => {
  try {
    const funds = await Fund.find().sort({ date: -1 });
    res.json(funds);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// PUT update fund status (approve / release)
app.put('/api/funds/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // Approved or Released
    const fund = await Fund.findById(id);
    if (!fund) return res.status(404).json({ message: 'Fund not found' });

    fund.status = status || fund.status;
    await fund.save();

    // If released -> deduct from FundPool and add history + mark complaint fundsReleased true
    if (status === 'Released') {
      const pool = await FundPool.findOne();
      if (!pool) return res.status(500).json({ message: 'FundPool not ready' });
      if (pool.total < fund.amount) return res.status(400).json({ message: 'Insufficient fund pool' });

      pool.total -= fund.amount;
      pool.history.push({ date: Date.now(), id: fund.complaintId, amount: fund.amount, note: fund.note || '' });
      await pool.save();

      // mark complaint fundsReleased true
      await Complaint.findOneAndUpdate({ _id: fund.complaintId }, { fundsReleased: true, status: 'Funds Released' });
    }

    res.json({ message: 'Fund status updated', fund });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// POST confirm resolved by student -> marks studentConfirmed true and attempts to release funds automatically
app.post('/api/complaints/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const comp = await Complaint.findById(id);
    if (!comp) return res.status(404).json({ message: 'Complaint not found' });

    if (!comp.solvedByVendor) return res.status(400).json({ message: 'Vendor has not marked solved' });
    if (comp.studentConfirmed) return res.status(400).json({ message: 'Already confirmed' });

    comp.studentConfirmed = true;
    comp.status = 'Confirmed by Student';
    await comp.save();

    // Create fund and release automatically if fundPool sufficient and adminSetAmount set
    const amount = comp.adminSetAmount || 1000;
    const pool = await FundPool.findOne();
    if (!pool) return res.status(500).json({ message: 'FundPool not initialized' });
    if (pool.total >= amount) {
      // create fund with status Released
      const f = await new Fund({ complaintId: comp._id.toString(), amount, note: 'Auto pay for ' + comp._id.toString(), status: 'Released' }).save();
      pool.total -= amount;
      pool.history.push({ date: Date.now(), id: comp._id.toString(), amount, note: 'Auto pay' });
      await pool.save();

      comp.fundsReleased = true;
      comp.status = 'Funds Released';
      await comp.save();

      res.json({ message: 'Confirmed and funds released', complaint: comp, fund: f, pool });
    } else {
      // create requested fund (not released)
      const f = await new Fund({ complaintId: comp._id.toString(), amount, note: 'Requested due to insufficient pool', status: 'Requested' }).save();
      res.json({ message: 'Confirmed. Funds requested (insufficient pool)', complaint: comp, fund: f, pool });
    }
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// GET fund pool
app.get('/api/fund-pool', async (req, res) => {
  try {
    const pool = await FundPool.findOne();
    res.json(pool);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Fallback: update complaint votes/admin actions via other endpoints already present.

// Start server
app.listen(port, () => {
  console.log(`🚀 Server running at ${renderURL}`);
});
