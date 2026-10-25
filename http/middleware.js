'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

function registerMiddlewares(app, { logging = true,
  allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://campus.example.com').split(',') } = {}) {
  const trustedProxies = process.env.TRUST_PROXY || 'loopback';
  const proxyAddresses = trustedProxies.split(',').map(value => value.trim()).filter(Boolean);
  if (proxyAddresses.some(value => ['true', '1', '*', '0.0.0.0/0', '::/0'].includes(value.toLowerCase()))) {
    throw new Error('TRUST_PROXY must name trusted proxy addresses or subnets');
  }
  app.set('trust proxy', proxyAddresses);
  app.use(compression({ level: 4 }));
  app.use(cors({
    origin: function(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true
  }));
  if (logging) app.use(morgan('dev'));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https://v1.hitokoto.cn', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));

  app.use(function(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 2000,
    standardHeaders: true,
    legacyHeaders: false
  }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 429, message: '请求过于频繁，请稍后再试' }
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 429, message: '登录尝试过多，请15分钟后再试' }
  });

  const captchaLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 429, message: '验证码请求过多，请15分钟后再试' }
  });

  app.use('/api/auth/login', loginLimiter, authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth/send-register-email-code', authLimiter);
  app.use('/api/auth/captcha', captchaLimiter);
}

module.exports = { registerMiddlewares };
