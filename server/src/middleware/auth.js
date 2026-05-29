const jwt = require('jsonwebtoken');

function authenticate(req, res, next) {
  const token = req.cookies?.phe_token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  };
}

// Attaches customer name to response only for admin/owner
function withCustomerVisibility(req) {
  return ['admin', 'owner'].includes(req.user?.role);
}

module.exports = { authenticate, authorize, withCustomerVisibility };
