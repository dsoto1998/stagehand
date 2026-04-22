##### **STAGEHAND - to-do list**



* Library Improvements

  * Make Playlists functional

    * Drag \& Drop from other parts of Library to Playlists
    * Add "Date" to Playlists and allow user to sort by soonest gig
    * Fix "Playlist Edit Mode" to persist until user presses "Confirm" or "Revert" (ask claude to access memory on this one
  * Create Albums tab
  * Group songs by Album within Artists tab - create distinct separation between each album, include track # and sort songs by track # within each album
  * Let user manually add Metadata



* Metronome Improvements

  * Later (Electron): Full automatic BPM + phase alignment using aubio/librosa



* Settings/Functionality

  * What audio formats are accepted?



* Long-Term Goals

  * Add VST Plugin Functionality
  * Remove "VST Plugins" section since that'd be part of "Live Input"
  * Add Chord Charts Functionality

    * tie to specific songs from Library
    * add Chord Chart icon in Library that displays the Chord Chart PDF
    * Support Chord Pro for custom charts / transposition?
  * AI Features

    * AI Stem separation using demucs6- see Gemini convo (https://github.com/adefossez/demucs)
    * AI Generated metronome for songs

      * independent volume control and subdivision options
      * Offset to accommodate for transposition delay
  * Add Album Artwork to MiniPlayer, Artists tab, and Albums tab

    * musicbrainz api for artwork: https://musicbrainz.org/doc/MusicBrainz\_API

