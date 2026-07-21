require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json()); // Vital para poder recibir datos en formato JSON en los POST

// Inicializar Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

let spotifyToken = '';
let tokenExpiry = 0;

// Función para obtener/renovar token de Spotify
async function getSpotifyToken() {
  const ahora = Date.now();
  if (spotifyToken && ahora < tokenExpiry) return spotifyToken;

  const credentials = btoa(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`);
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const data = await response.json();
  spotifyToken = data.access_token;
  tokenExpiry = ahora + (data.expires_in - 10) * 1000;
  console.log('🔄 Token de Spotify renovado con éxito');
  return spotifyToken;
}

// 1. RUTA DE BÚSQUEDA
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta el parámetro de búsqueda' });

  try {
    const token = await getSpotifyToken();
    const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=album&limit=6`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();

    const albums = data.albums.items.map(album => ({
      id: album.id,
      title: album.name,
      artist: album.artists[0].name,
      coverUrl: album.images[0]?.url,
      releaseDate: album.release_date,
      spotifyLink: album.external_urls.spotify
    }));

    res.json(albums);
  } catch (error) {
    res.status(500).json({ error: 'Error al conectar con Spotify' });
  }
});

// 2. NUEVA RUTA: REGISTRAR UNA ESCUCHA
app.post('/api/listen', async (req, res) => {
  const { albumId, userId, rating, review } = req.body;

  if (!albumId || !userId) {
    return res.status(400).json({ error: 'Faltan campos obligatorios: albumId o userId' });
  }

  try {
    const { data: existingAlbum } = await supabase
      .from('albums')
      .select('spotify_id')
      .eq('spotify_id', albumId)
      .single();

    if (!existingAlbum) {
      const token = await getSpotifyToken();
      const spotifyResponse = await fetch(`https://api.spotify.com/v1/albums/${albumId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!spotifyResponse.ok) throw new Error('Álbum no encontrado en Spotify');
      const albumData = await spotifyResponse.json();

      const totalDurationMs = albumData.tracks.items.reduce((acc, track) => acc + track.duration_ms, 0);

      const { error: albumError } = await supabase
        .from('albums')
        .insert([{
          spotify_id: albumData.id,
          title: albumData.name,
          artist: albumData.artists[0].name,
          cover_url: albumData.images[0]?.url,
          duration_ms: totalDurationMs
        }]);

      if (albumError) throw albumError;
      console.log(`💾 Nuevo álbum guardado en caché: ${albumData.name}`);
    }

    const { data: newListen, error: listenError } = await supabase
      .from('listens')
      .insert([{
        user_id: userId,
        album_id: albumId,
        rating: rating || null,
        review: review || null
      }])
      .select();

    if (listenError) throw listenError;

    res.status(201).json({ success: true, message: 'Escucha registrada con éxito en tornamesa', data: newListen });

  } catch (error) {
    console.error('❌ Error en /api/listen:', error.message);
    res.status(500).json({ error: 'Error interno al procesar el registro' });
  }
});

// 3. OBTENER HISTORIAL Y ESTADÍSTICAS DEL USUARIO
app.get('/api/users/:userId/history', async (req, res) => {
  const { userId } = req.params;

  try {
    const { data: history, error: historyError } = await supabase
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
      .order('listened_at', { ascending: false });

    if (historyError) throw historyError;

    const totalListens = history.length;
    const totalMs = history.reduce((acc, item) => acc + (item.albums?.duration_ms || 0), 0);
    const totalMinutes = Math.round(totalMs / 1000 / 60);

    res.json({
      stats: {
        totalAlbumsListened: totalListens,
        totalMinutesSpended: totalMinutes
      },
      history: history
    });

  } catch (error) {
    console.error('❌ Error en /api/users/:userId/history:', error.message);
    res.status(500).json({ error: 'Error al obtener el historial' });
  }
});

// 4. GENERAR EL RESUMEN MENSUAL DEL USUARIO
app.post('/api/users/:userId/summaries/generate', async (req, res) => {
  const { userId } = req.params;
  const { year, month } = req.body;

  if (!year || !month) {
    return res.status(400).json({ error: 'Faltan parámetros: year y month son obligatorios' });
  }

  try {
    const startDate = new Date(year, month - 1, 1).toISOString();
    const endDate = new Date(year, month, 1).toISOString();

    const { data: listens, error: listensError } = await supabase
      .from('listens')
      .select(`
        album_id,
        albums (title, artist, duration_ms)
      `)
      .eq('user_id', userId)
      .gte('listened_at', startDate)
      .lt('listened_at', endDate);

    if (listensError) throw listensError;

    if (!listens || listens.length === 0) {
      return res.status(404).json({ message: 'No se encontraron escuchas para este usuario en el mes seleccionado.' });
    }

    let totalMs = 0;
    const albumCounts = {};
    const artistCounts = {};
    const uniqueAlbums = new Map();

    listens.forEach(listen => {
      const album = listen.albums;
      if (!album) return;

      totalMs += album.duration_ms;
      albumCounts[listen.album_id] = (albumCounts[listen.album_id] || 0) + 1;
      artistCounts[album.artist] = (artistCounts[album.artist] || 0) + 1;

      if (!uniqueAlbums.has(listen.album_id)) {
        uniqueAlbums.set(listen.album_id, album.duration_ms);
      }
    });

    const mostListenedAlbumId = Object.keys(albumCounts).reduce((a, b) => albumCounts[a] > albumCounts[b] ? a : b);
    const topArtist = Object.keys(artistCounts).reduce((a, b) => artistCounts[a] > artistCounts[b] ? a : b);

    let longestAlbumId = null;
    let maxDuration = 0;
    uniqueAlbums.forEach((duration, id) => {
      if (duration > maxDuration) {
        maxDuration = duration;
        longestAlbumId = id;
      }
    });

    const totalMinutes = Math.round(totalMs / 1000 / 60);
    const totalListens = listens.length;

    const { data: summary, error: summaryError } = await supabase
      .from('monthly_summaries')
      .upsert({
        user_id: userId,
        year,
        month,
        total_minutes: totalMinutes,
        total_listens: totalListens,
        most_listened_album_id: mostListenedAlbumId,
        longest_album_id: longestAlbumId,
        top_artist: topArtist
      }, { onConflict: 'user_id, year, month' })
      .select();

    if (summaryError) throw summaryError;

    res.json({
      success: true,
      message: `✨ ¡Resumen de tornamesa generado para el mes ${month}/${year}!`,
      summary: summary[0]
    });

  } catch (error) {
    console.error('❌ Error al generar resumen:', error.message);
    res.status(500).json({ error: 'Error interno al procesar el resumen mensual' });
  }
});

// 5. NUEVA RUTA: OBTENER PERFIL ACTUAL DEL USUARIO
app.get('/api/users/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('username, bio')
      .eq('id', userId)
      .single();

    // Si todavía no tiene perfil creado, devolvemos campos vacíos en vez de error
    if (error && error.code === 'PGRST116') {
      return res.json({ username: '', bio: '' });
    }
    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('❌ Error en GET /api/users/:userId:', error.message);
    res.status(500).json({ error: 'Error al obtener el perfil' });
  }
});

// 6. NUEVA RUTA: ACTUALIZAR O CREAR EL PERFIL DEL USUARIO
app.put('/api/users/:userId', async (req, res) => {
  const { userId } = req.params;
  const { username, bio } = req.body;

  try {
    const { data, error } = await supabase
      .from('profiles')
      .upsert({ id: userId, username, bio })
      .select();

    if (error) throw error;

    res.json({ success: true, message: 'Perfil actualizado con éxito', data });
  } catch (error) {
    console.error('❌ Error en PUT /api/users/:userId:', error.message);
    res.status(500).json({ error: 'Error interno al actualizar el perfil' });
  }
});

app.get('/api/profiles/username/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, bio')
      .ilike('username', username) // 👈 .ilike ignora mayúsculas y minúsculas
      .single();

    if (error) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(data);
  } catch (error) {
    console.error('❌ Error en GET /api/profiles/username/:username:', error.message);
    res.status(500).json({ error: 'Error al obtener el perfil' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor de tornamesa en puerto ${PORT}`));
