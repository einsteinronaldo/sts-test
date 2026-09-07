/*
 * Returns the Google Maps API key for client-side address autocomplete.
 * Source: NEXT_PUBLIC_GOOGLE_MAPS_API_KEY environment variable.
 *
 * This is a browser-side key protected by HTTP referrer / API restrictions
 * in Google Cloud Console, not by server-side secrecy.
 */
export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return Response.json(
        { ok: false, error: 'Método não permitido.' },
        { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } }
      );
    }
    var key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '';
    if (!key) {
      return Response.json(
        { ok: false, error: 'Google Maps key not configured.' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    return Response.json(
      { ok: true, googleMapsApiKey: key },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  },
};
