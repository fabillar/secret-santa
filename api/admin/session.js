// GET    /api/admin/session               -> { authenticated }
// POST   /api/admin/session { password }  -> log in (sets HttpOnly cookie)
// DELETE /api/admin/session               -> log out
import { endpoint, sendJson, readJson, HttpError } from '../_lib/http.js';
import {
  rateLimit, isAdmin, checkAdminPassword, createAdminSession, destroyAdminSession,
} from '../_lib/security.js';

export default endpoint(['GET', 'POST', 'DELETE'], async (req, res) => {
  if (req.method === 'GET') {
    await rateLimit(req, 'admin-session', 120, 60_000);
    sendJson(res, 200, { authenticated: await isAdmin(req) });
    return;
  }

  if (req.method === 'DELETE') {
    await destroyAdminSession(req, res);
    sendJson(res, 200, { authenticated: false });
    return;
  }

  // Brute-force protection: per-IP limit plus a lower global ceiling.
  await rateLimit(req, 'admin-login', 8, 15 * 60_000);
  await rateLimit(req, 'admin-login', 40, 15 * 60_000, { global: true });
  const body = await readJson(req);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password || password.length > 200) throw new HttpError(400, 'Password is required', 'VALIDATION');

  if (!checkAdminPassword(password)) {
    // Small fixed delay makes online guessing even slower.
    await new Promise((r) => setTimeout(r, 400));
    throw new HttpError(401, 'Incorrect password', 'BAD_PASSWORD');
  }
  await createAdminSession(req, res);
  sendJson(res, 200, { authenticated: true });
});
