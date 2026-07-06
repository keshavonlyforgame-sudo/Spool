# Spool — Deploy Guide (Hindi/Hinglish)

Is folder mein aapka poora music player app hai. Ise phone par "real app" ki tarah
chalane ke liye neeche diye steps follow karo — koi coding knowledge nahi chahiye.

## Step 1: GitHub par account banao
1. https://github.com par jao aur free account banao (agar pehle se nahi hai)
2. "New repository" par click karo
3. Naam do: `spool-music-player` → Create repository

## Step 2: Files upload karo
1. Naye repo page par "uploading an existing file" link par click karo
2. Is poore folder ke andar ki SAARI files aur folders (package.json, index.html,
   src/, public/, vite.config.js, wagera) drag-and-drop karke upload karo
3. Neeche "Commit changes" button dabao

## Step 3: Vercel se deploy karo
1. https://vercel.com par jao aur "Continue with GitHub" se sign up karo
2. "Add New Project" dabao
3. Apna `spool-music-player` repo select karo aur "Import" karo
4. Vercel khud detect kar lega ki ye Vite project hai — kuch change mat karo
5. "Deploy" button dabao aur 1-2 minute wait karo

## Step 4: Apna app link lo
Deploy hone ke baad Vercel ek link dega, jaise:
`https://spool-music-player.vercel.app`

## Step 5: Phone par install karo
1. Phone ke browser (Chrome/Safari) mein wo link kholo
2. Browser menu mein "Add to Home Screen" ya "Install App" option dhundo aur tap karo
3. Ab aapke phone home screen par "Spool" icon aa jayega — isay normal app ki
   tarah open kar sakte ho

## Future changes
Agar kabhi is app mein kuch badalna ho:
- Claude ko bolo kya change chahiye
- Claude `src/MusicPlayer.jsx` file update karke de dega
- Us updated file ko GitHub repo mein wapas upload karo (same jagah replace kar do)
- Vercel apne aap 1-2 minute mein naya version deploy kar dega — link wahi rahega
