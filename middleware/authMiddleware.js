/**
 * shared-utils/middleware/authMiddleware.js
 * ──────────────────────────────────────────
 * Unified JWT authentication middleware for all NBU-Net microservices.
 *
 * Features:
 *  • Bearer token extraction from Authorization header OR cookie
 *  • Internal service-to-service bypass via x-api-key header
 *  • Standardized req.user payload across every service
 *  • Safe error messages — no raw JWT error details exposed to client
 */

const jwt = require('jsonwebtoken');

const authMiddleware = (options = {}) => (req, res, next) => {
    const isOptional = options.optional === true;

    // ── Internal service-to-service bypass ────────────────────────────────────
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === process.env.SYSTEM_API_KEY) {
        req.user = {
            id:          'SYSTEM',
            email:       'system@nbu.internal',
            userType:    'ADMIN',
            roles:       ['SYSTEM'],
            permissions: ['*']
        };
        return next();
    }

    // ── Extract bearer token ──────────────────────────────────────────────────
    let token;
    if (req.headers.authorization?.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.token) {
        token = req.cookies.token;
    }

    if (!token) {
        if (isOptional) return next();
        return res.status(401).json({ message: 'Authentication required. No token provided.' });
    }

    // ── Verify & decode ───────────────────────────────────────────────────────
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Standardized req.user shape — the same across all services
        req.user = {
            id:           decoded.userId,
            email:        decoded.email,
            firstName:    decoded.firstName,
            lastName:     decoded.lastName,
            middleName:   decoded.middleName,
            userType:     decoded.userType,
            permissions:  decoded.permissions  || [],
            roles:        decoded.roles        || [],
            facultyId:    decoded.facultyId,
            departmentId: decoded.departmentId,
            programLevelId: decoded.programLevelId,
            programType:  decoded.programType,
        };

        next();
    } catch (err) {
        if (isOptional) return next();
        
        // Distinguish expired vs invalid without exposing raw error
        const msg = err.name === 'TokenExpiredError'
            ? 'Session expired. Please log in again.'
            : 'Invalid or malformed token.';
        return res.status(401).json({ message: msg });
    }
};

// Backwards compatibility for existing usage: const authMiddleware = require(...)
const defaultAuthMiddleware = authMiddleware();
defaultAuthMiddleware.withOptions = authMiddleware;

module.exports = defaultAuthMiddleware;
