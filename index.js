require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// 🔒 MIDDLEWARE
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://tornamesa-frontend.onrender.com',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json({ limit: '10kb' }));

// 🔧 INICIALIZACIÓN SUPABASE
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 📡 MANEJO DE TOKEN SPOTIFY CON CACHE
let spotifyToken = '';
let tokenExpiry = 0;

async function getSpotifyToken() {
  const now = Date.now();
  if (spotifyToken && now < tokenExpiry) return spotifyToken;

  try {
    const credentials = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    if (!response.ok) throw new Error('Spotify token request failed');

    const data = await response.json();
    spotifyToken = data.access_token;
    tokenExpiry = now + (data.expires_in - 60) * 1000; // Renovar 60s antes
    console.log('✅ Token Spotify renovado');
    return spotifyToken;
  } catch (error) {
    console.error('❌ Error obteniendo token Spotify:', error.message);
    throw new Error('No se pudo obtener token de Spotify');
  }
}

// 🛡️ FUNCIONES DE VALIDACIÓN
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateUsername(username) {
  return /^[a-zA-Z0-9_-]{3,20}$/.test(username);
}

function sanitizeString(str) {
  return str?.trim().substring(0, 500) || '';
}

// ⚠️ MIDDLEWARE DE ERRORES
function handleError(res, error, statusCode = 500) {
  console.error('Error:', error.message);
  res.status(statusCode).json({
    error: error.message || 'Error interno del servidor'
  });
}

// ==================== ENDPOINTS API ====================

// 1️⃣ BÚSQUEDA DE ÁLBUMES
app.get('/api/search', async (req, res) => {
  const { q } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Búsqueda debe tener al menos 2 caracteres' });
  }

  try {
    const token = await getSpotifyToken();
    const response = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=album&limit=10`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    if (!response.ok) throw new Error('Error en búsqueda de Spotify');

    const data = await response.json();
    const albums = data.albums.items.map(album => ({
      id: album.id,
      title: album.name,
      artist: album.artists[0]?.name || 'Unknown',
      coverUrl: album.images[0]?.url || null,
      releaseDate: album.release_date,
      spotifyLink: album.external_urls.spotify
    }));

    res.json(albums);
  } catch (error) {
    handleError(res, error, 500);
  }
});

// 2️⃣ REGISTRAR ESCUCHA
app.post('/api/listen', async (req, res) => {
  const { albumId, userId, rating, review } = req.body;

  // Validaciones
  if (!albumId || !userId) {
    return res.status(400).json({ error: 'Faltan albumId o userId' });
  }
  if (rating && (rating < 1 || rating > 5)) {
    return res.status(400).json({ error: 'Rating debe estar entre 1 y 5' });
  }

  try {
    // Verificar si usuario existe
    const { data: userData } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .single();

    if (!userData) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Buscar álbum en caché
    const { data: existingAlbum } = await supabase
      .from('albums')
      .select('spotify_id')
      .eq('spotify_id', albumId)
      .single();

    if (!existingAlbum) {
      // Obtener datos de Spotify y guardar
      const token = await getSpotifyToken();
      const spotifyResponse = await fetch(`https://api.spotify.com/v1/albums/${albumId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!spotifyResponse.ok) {
        return res.status(404).json({ error: 'Álbum no encontrado en Spotify' });
      }

      const albumData = await spotifyResponse.json();
      const totalDuration = albumData.tracks.items.reduce((acc, track) => acc + track.duration_ms, 0);

      await supabase.from('albums').insert([{
        spotify_id: albumData.id,
        title: albumData.name,
        artist: albumData.artists[0]?.name || 'Unknown',
        cover_url: albumData.images[0]?.url || null,
        duration_ms: totalDuration
      }]);

      console.log(`💾 Álbum guardado: ${albumData.name}`);
    }

    // Registrar escucha
    const { data: newListen, error: listenError } = await supabase
      .from('listens')
      .insert([{
        user_id: userId,
        album_id: albumId,
        rating: rating || null,
        review: sanitizeString(review)
      }])
      .select();

    if (listenError) throw listenError;

    res.status(201).json({
      success: true,
      message: 'Escucha registrada',
      data: newListen[0]
    });
  } catch (error) {
    handleError(res, error);
  }
});

// 3️⃣ OBTENER HISTORIAL DEL USUARIO
app.get('/api/users/:userId/history', async (req, res) => {
  const { userId } = req.params;
  const { limit = 50, offset = 0 } = req.query;

  try {
    const { data: history, error } = await supabase
      .from('listens')
      .select(`
        id,
        listened_at,
        rating,
        review,
        albums (
          spotify_id,
          title,
          artist,
          cover_url,
          duration_ms
        )
      `)
      .eq('user_id', userId)
      .order('listened_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const totalMinutes = history.reduce((acc, item) =>
      acc + (item.albums?.duration_ms || 0), 0
    ) / 1000 / 60;

    res.json({
      stats: {
        totalAlbumsListened: history.length,
        totalMinutesSpended: Math.round(totalMinutes)
      },
      history: history || []
    });
  } catch (error) {
    handleError(res, error);
  }
});

// 4️⃣ OBTENER PERFIL PÚBLICO DEL USUARIO
app.get('/api/profiles/username/:username', async (req, res) => {
  const { username } = req.params;

  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, username, bio, created_at')
      .ilike('username', `${username}%`)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Obtener estadísticas del usuario
    const { data: listens } = await supabase
      .from('listens')
      .select('rating, albums(duration_ms)')
      .eq('user_id', profile.id);

    const ratings = listens
      .filter(l => l.rating)
      .map(l => l.rating);

    const totalMinutes = listens.reduce((acc, l) =>
      acc + (l.albums?.duration_ms || 0), 0
    ) / 1000 / 60;

    const ratingsDistribution = {
      '5': ratings.filter(r => r === 5).length,
      '4': ratings.filter(r => r === 4).length,
      '3': ratings.filter(r => r === 3).length,
      '2': ratings.filter(r => r === 2).length,
      '1': ratings.filter(r => r === 1).length
    };

    res.json({
      ...profile,
      stats: {
        totalAlbumsListened: listens.length,
        totalMinutesSpended: Math.round(totalMinutes),
        ratingsDistribution,
        averageRating: ratings.length > 0
          ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)
          : 0
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

// 5️⃣ OBTENER PERFIL DEL USUARIO AUTENTICADO
app.get('/api/users/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, bio')
      .eq('id', userId)
      .single();

    if (error && error.code === 'PGRST116') {
      return res.json({ id: userId, username: '', bio: '' });
    }
    if (error) throw error;

    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// 6️⃣ ACTUALIZAR PERFIL DEL USUARIO
app.put('/api/users/:userId', async (req, res) => {
  const { userId } = req.params;
  const { username, bio } = req.body;

  // Validaciones
  if (username && !validateUsername(username)) {
    return res.status(400).json({
      error: 'Username inválido. Solo letras, números, _ y -. Entre 3-20 caracteres.'
    });
  }

  try {
    // Verificar que el username no esté en uso
    if (username) {
      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .ilike('username', username)
        .not('id', 'eq', userId)
        .single();

      if (existing) {
        return res.status(409).json({ error: 'Username ya está en uso' });
      }
    }

    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        id: userId,
        username: username ? username.toLowerCase() : undefined,
        bio: sanitizeString(bio)
      }, { onConflict: 'id' })
      .select();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Perfil actualizado',
      data: data[0]
    });
  } catch (error) {
    handleError(res, error);
  }
});

// 7️⃣ GENERAR RESUMEN MENSUAL
app.post('/api/users/:userId/summaries/generate', async (req, res) => {
  const { userId } = req.params;
  const { year, month } = req.body;

  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year y month (1-12) son obligatorios' });
  }

  try {
    const startDate = new Date(year, month - 1, 1).toISOString();
    const endDate = new Date(year, month, 1).toISOString();

    const { data: listens, error } = await supabase
      .from('listens')
      .select('album_id, albums(title, artist, duration_ms)')
      .eq('user_id', userId)
      .gte('listened_at', startDate)
      .lt('listened_at', endDate);

    if (error) throw error;

    if (!listens || listens.length === 0) {
      return res.status(404).json({
        message: 'No hay escuchas para este mes'
      });
    }

    let totalMs = 0;
    const albumCounts = {};
    const artistCounts = {};

    listens.forEach(listen => {
      const album = listen.albums;
      if (!album) return;

      totalMs += album.duration_ms;
      albumCounts[listen.album_id] = (albumCounts[listen.album_id] || 0) + 1;
      artistCounts[album.artist] = (artistCounts[album.artist] || 0) + 1;
    });

    const topAlbumId = Object.keys(albumCounts).reduce((a, b) =>
      albumCounts[a] > albumCounts[b] ? a : b, null
    );
    const topArtist = Object.keys(artistCounts).reduce((a, b) =>
      artistCounts[a] > artistCounts[b] ? a : b, null
    );

    const { data: summary, error: summaryError } = await supabase
      .from('monthly_summaries')
      .upsert({
        user_id: userId,
        year,
        month,
        total_minutes: Math.round(totalMs / 1000 / 60),
        total_listens: listens.length,
        most_listened_album_id: topAlbumId,
        top_artist: topArtist
      }, { onConflict: 'user_id,year,month' })
      .select();

    if (summaryError) throw summaryError;

    res.json({
      success: true,
      message: `Resumen generado para ${month}/${year}`,
      summary: summary[0]
    });
  } catch (error) {
    handleError(res, error);
  }
});

// 8️⃣ OBTENER HISTORIAL PÚBLICO DEL USUARIO (para perfil)
app.get('/api/profiles/:username/history', async (req, res) => {
  const { username } = req.params;
  const { limit = 20 } = req.query;

  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .ilike('username', username)
      .single();

    if (profileError) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const { data: history, error } = await supabase
      .from('listens')
      .select(`
        id,
        listened_at,
        rating,
        albums (
          spotify_id,
          title,
          artist,
          cover_url
        )
      `)
      .eq('user_id', profile.id)
      .order('listened_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json(history || []);
  } catch (error) {
    handleError(res, error);
  }
});

// ❤️ HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 404 HANDLER
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

// 🚀 START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║      🎵 TORNAMESA BACKEND             ║
║      Puerto: ${PORT}                    ║
║      Env: ${process.env.NODE_ENV || 'development'}          ║
╚════════════════════════════════════════╝
  `);
});

module.exports = app;
