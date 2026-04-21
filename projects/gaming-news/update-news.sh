#!/bin/bash
# Gaming News Updater Script
# Dijalankan setiap 15 menit via cron

INDEX_FILE="/Users/ryan.setiawan/Downloads/VirtualOffice/projects/gaming-news/index.html"
TIMESTAMP=$(date -Iseconds)

# Fungsi untuk mendapatkan favicon dari URL
get_favicon() {
    local url="$1"
    local domain=$(echo "$url" | sed -E 's|https?://([^/]+).*|\1|')
    echo "https://${domain}/favicon.ico"
}

# Fungsi untuk mendapatkan nama media dari URL
get_media_name() {
    local url="$1"
    local domain=$(echo "$url" | sed -E 's|https?://([^/]+).*|\1|')
    local domain_clean=$(echo "$domain" | sed 's/^www\.//')

    case "$domain_clean" in
        gematsu.com) echo "Gematsu" ;;
        ign.com) echo "IGN" ;;
        gamespot.com) echo "GameSpot" ;;
        nintendolife.com) echo "Nintendo Life" ;;
        pcgamer.com) echo "PC Gamer" ;;
        polygon.com) echo "Polygon" ;;
        kotaku.com) echo "Kotaku" ;;
        eurogamer.net) echo "Eurogamer" ;;
        gamesindustry.biz) echo "GamesIndustry.biz" ;;
        vg247.com) echo "VG247" ;;
        rockpapershotgun.com) echo "Rock Paper Shotgun" ;;
        theverge.com) echo "The Verge" ;;
        gamespress.com) echo "Games Press" ;;
        monstervine.com) echo "MonsterVine" ;;
        *) echo "$domain_clean" ;;
    esac
}

# Cari berita gaming terbaru (excluding esports)
# Menggunakan RSS feed atau search
echo "Mencari berita gaming terbaru..."

# Placeholder untuk demo - dalam production, gunakan RSS feed atau API
# Contoh menggunakan Gematsu RSS
NEWS_DATA=$(curl -s "https://www.gematsu.com/feed" 2>/dev/null | head -100)

# Generate placeholder news (untuk demo purposes)
# Dalam implementasi nyata, parse dari RSS/API
cat > /tmp/gaming_news.json << 'EOF'
[
  {
    "judul": "Berita Gaming 1",
    "ringkasan": "Ringkasan berita terbaru dari dunia gaming.",
    "kategori": "News",
    "sumber": "https://www.gematsu.com",
    "media": "Gematsu",
    "logo": "https://www.gematsu.com/favicon.ico"
  }
]
EOF

echo "Update completed at $TIMESTAMP"
