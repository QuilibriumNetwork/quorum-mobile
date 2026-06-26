/**
 * EmojiPicker - Full emoji picker with categories
 * All emojis are bundled locally (no remote assets)
 * Supports custom space emojis displayed as images
 * Tracks emoji usage with frecency (frequency + recency)
 */

import type { AppTheme } from '@/theme';
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, Modal, Pressable, TextInput, Image, Keyboard, Platform, Animated, Dimensions } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol } from '@/components/ui/IconSymbol';
import type { Emoji } from '@quilibrium/quorum-shared';
import { useEmojiFrecency } from '@/hooks/useEmojiFrecency';
import { EMOJI_KEYWORDS, searchEmojis } from '@/data/emojiData';
import * as Skin from '@/theme/skins/geometry';

const SCREEN_HEIGHT = Dimensions.get('window').height;

// Custom emoji type for the picker (includes isCustom flag for rendering)
type PickerEmoji = {
  value: string; // For standard: the emoji char. For custom: the emoji ID
  isCustom: boolean;
  imgUrl?: string; // Only for custom emojis
  name?: string; // For display/search
};

// Emoji categories with local emoji data
const EMOJI_CATEGORIES = {
  recent: {
    name: 'Recent',
    icon: '🕐',
    emojis: [] as string[], // Will be populated from usage
  },
  smileys: {
    name: 'Smileys',
    icon: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
      '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '☺️', '😚',
      '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭',
      '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄',
      '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕',
      '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳',
      '🥸', '😎', '🤓', '🧐', '😕', '😟', '🙁', '☹️', '😮', '😯',
      '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭',
      '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡',
      '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺',
      '👻', '👽', '👾', '🤖', '😺', '😸', '😹', '😻', '😼', '😽',
      '🙀', '😿', '😾',
    ],
  },
  gestures: {
    name: 'Gestures',
    icon: '👋',
    emojis: [
      '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞',
      '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍',
      '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝',
      '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂',
      '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅',
      '👄', '💋', '🩸',
    ],
  },
  people: {
    name: 'People',
    icon: '👶',
    emojis: [
      '👶', '👧', '🧒', '👦', '👩', '🧑', '👨', '👩‍🦱', '🧑‍🦱', '👨‍🦱',
      '👩‍🦰', '🧑‍🦰', '👨‍🦰', '👱‍♀️', '👱', '👱‍♂️', '👩‍🦳', '🧑‍🦳', '👨‍🦳', '👩‍🦲',
      '🧑‍🦲', '👨‍🦲', '🧔', '👵', '🧓', '👴', '👲', '👳‍♀️', '👳', '👳‍♂️',
      '🧕', '👮‍♀️', '👮', '👮‍♂️', '👷‍♀️', '👷', '👷‍♂️', '💂‍♀️', '💂', '💂‍♂️',
      '🕵️‍♀️', '🕵️', '🕵️‍♂️', '👩‍⚕️', '🧑‍⚕️', '👨‍⚕️', '👩‍🌾', '🧑‍🌾', '👨‍🌾', '👩‍🍳',
      '🧑‍🍳', '👨‍🍳', '👩‍🎓', '🧑‍🎓', '👨‍🎓', '👩‍🎤', '🧑‍🎤', '👨‍🎤', '👩‍🏫', '🧑‍🏫',
      '👨‍🏫', '👩‍🏭', '🧑‍🏭', '👨‍🏭', '👩‍💻', '🧑‍💻', '👨‍💻', '👩‍💼', '🧑‍💼', '👨‍💼',
    ],
  },
  nature: {
    name: 'Nature',
    icon: '🐶',
    emojis: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨',
      '🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈', '🙉', '🙊',
      '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉',
      '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🐛', '🦋', '🐌',
      '🐞', '🐜', '🪰', '🪲', '🪳', '🦟', '🦗', '🕷️', '🕸️', '🦂',
      '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀',
      '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆',
      '🦓', '🦍', '🦧', '🦣', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒',
      '🦘', '🦬', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙',
      '🐐', '🦌', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🪶', '🐓',
      '🦃', '🦤', '🦚', '🦜', '🦢', '🦩', '🕊️', '🐇', '🦝', '🦨',
      '🦡', '🦫', '🦦', '🦥', '🐁', '🐀', '🐿️', '🦔',
    ],
  },
  food: {
    name: 'Food',
    icon: '🍔',
    emojis: [
      '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐',
      '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑',
      '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅',
      '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳',
      '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔',
      '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗',
      '🥘', '🫕', '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟',
      '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡',
      '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬',
      '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '🍼', '🫖',
      '☕', '🍵', '🧃', '🥤', '🧋', '🍶', '🍺', '🍻', '🥂', '🍷',
      '🥃', '🍸', '🍹', '🧉', '🍾', '🧊', '🥄', '🍴', '🍽️', '🥣',
      '🥡', '🥢', '🧂',
    ],
  },
  activities: {
    name: 'Activities',
    icon: '⚽',
    emojis: [
      '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱',
      '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳',
      '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷',
      '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️‍♀️', '🏋️', '🏋️‍♂️', '🤼‍♀️',
      '🤼', '🤼‍♂️', '🤸‍♀️', '🤸', '🤸‍♂️', '⛹️‍♀️', '⛹️', '⛹️‍♂️', '🤺', '🤾‍♀️',
      '🤾', '🤾‍♂️', '🏌️‍♀️', '🏌️', '🏌️‍♂️', '🏇', '🧘‍♀️', '🧘', '🧘‍♂️', '🏄‍♀️',
      '🏄', '🏄‍♂️', '🏊‍♀️', '🏊', '🏊‍♂️', '🤽‍♀️', '🤽', '🤽‍♂️', '🚣‍♀️', '🚣',
      '🚣‍♂️', '🧗‍♀️', '🧗', '🧗‍♂️', '🚵‍♀️', '🚵', '🚵‍♂️', '🚴‍♀️', '🚴', '🚴‍♂️',
      '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️', '🎫', '🎟️',
      '🎪', '🤹‍♀️', '🤹', '🤹‍♂️', '🎭', '🩰', '🎨', '🎬', '🎤', '🎧',
      '🎼', '🎹', '🥁', '🪘', '🎷', '🎺', '🪗', '🎸', '🪕', '🎻',
      '🎲', '♟️', '🎯', '🎳', '🎮', '🎰', '🧩',
    ],
  },
  travel: {
    name: 'Travel',
    icon: '🚗',
    emojis: [
      '🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐',
      '🛻', '🚚', '🚛', '🚜', '🦯', '🦽', '🦼', '🛴', '🚲', '🛵',
      '🏍️', '🛺', '🚨', '🚔', '🚍', '🚘', '🚖', '🚡', '🚠', '🚟',
      '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇',
      '🚊', '🚉', '✈️', '🛫', '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸',
      '🚁', '🛶', '⛵', '🚤', '🛥️', '🛳️', '⛴️', '🚢', '⚓', '🪝',
      '⛽', '🚧', '🚦', '🚥', '🚏', '🗺️', '🗿', '🗽', '🗼', '🏰',
      '🏯', '🏟️', '🎡', '🎢', '🎠', '⛲', '⛱️', '🏖️', '🏝️', '🏜️',
      '🌋', '⛰️', '🏔️', '🗻', '🏕️', '⛺', '🛖', '🏠', '🏡', '🏘️',
      '🏚️', '🏗️', '🏭', '🏢', '🏬', '🏣', '🏤', '🏥', '🏦', '🏨',
      '🏪', '🏫', '🏩', '💒', '🏛️', '⛪', '🕌', '🕍', '🛕', '🕋',
      '⛩️', '🛤️', '🛣️', '🗾', '🎑', '🏞️', '🌅', '🌄', '🌠', '🎇',
      '🎆', '🌇', '🌆', '🏙️', '🌃', '🌌', '🌉', '🌁',
    ],
  },
  objects: {
    name: 'Objects',
    icon: '💡',
    emojis: [
      '⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️',
      '🗜️', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥',
      '📽️', '🎞️', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️',
      '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛', '⏳', '📡', '🔋',
      '🔌', '💡', '🔦', '🕯️', '🪔', '🧯', '🛢️', '💸', '💵', '💴',
      '💶', '💷', '🪙', '💰', '💳', '💎', '⚖️', '🪜', '🧰', '🪛',
      '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🪚', '🔩', '⚙️', '🪤', '🧱',
      '⛓️', '🧲', '🔫', '💣', '🧨', '🪓', '🔪', '🗡️', '⚔️', '🛡️',
      '🚬', '⚰️', '🪦', '⚱️', '🏺', '🔮', '📿', '🧿', '💈', '⚗️',
      '🔭', '🔬', '🕳️', '🩹', '🩺', '💊', '💉', '🩸', '🧬', '🦠',
      '🧫', '🧪', '🌡️', '🧹', '🪠', '🧺', '🧻', '🚽', '🚰', '🚿',
      '🛁', '🛀', '🧼', '🪥', '🪒', '🧽', '🪣', '🧴', '🛎️', '🔑',
      '🗝️', '🚪', '🪑', '🛋️', '🛏️', '🛌', '🧸', '🪆', '🖼️', '🪞',
      '🪟', '🛍️', '🛒', '🎁', '🎈', '🎏', '🎀', '🪄', '🪅', '🎊',
      '🎉', '🎎', '🏮', '🎐', '🧧', '✉️', '📩', '📨', '📧', '💌',
      '📥', '📤', '📦', '🏷️', '🪧', '📪', '📫', '📬', '📭', '📮',
      '📯', '📜', '📃', '📄', '📑', '🧾', '📊', '📈', '📉', '🗒️',
      '🗓️', '📆', '📅', '🗑️', '📇', '🗃️', '🗳️', '🗄️', '📋', '📁',
      '📂', '🗂️', '🗞️', '📰', '📓', '📔', '📒', '📕', '📗', '📘',
      '📙', '📚', '📖', '🔖', '🧷', '🔗', '📎', '🖇️', '📐', '📏',
      '🧮', '📌', '📍', '✂️', '🖊️', '🖋️', '✒️', '🖌️', '🖍️', '📝',
      '✏️', '🔍', '🔎', '🔏', '🔐', '🔒', '🔓',
    ],
  },
  symbols: {
    name: 'Symbols',
    icon: '❤️',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️',
      '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐',
      '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐',
      '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳',
      '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️',
      '㊗️', '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️',
      '🆘', '❌', '⭕', '🛑', '⛔', '📛', '🚫', '💯', '💢', '♨️',
      '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗', '❕', '❓',
      '❔', '‼️', '⁉️', '🔅', '🔆', '〽️', '⚠️', '🚸', '🔱', '⚜️',
      '🔰', '♻️', '✅', '🈯', '💹', '❇️', '✳️', '❎', '🌐', '💠',
      'Ⓜ️', '🌀', '💤', '🏧', '🚾', '♿', '🅿️', '🛗', '🈳', '🈂️',
      '🛂', '🛃', '🛄', '🛅', '🚹', '🚺', '🚼', '⚧', '🚻', '🚮',
      '🎦', '📶', '🈁', '🔣', 'ℹ️', '🔤', '🔡', '🔠', '🆖', '🆗',
      '🆙', '🆒', '🆕', '🆓', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣',
      '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟', '🔢', '#️⃣', '*️⃣', '⏏️', '▶️',
      '⏸️', '⏯️', '⏹️', '⏺️', '⏭️', '⏮️', '⏩', '⏪', '⏫', '⏬',
      '◀️', '🔼', '🔽', '➡️', '⬅️', '⬆️', '⬇️', '↗️', '↘️', '↙️',
      '↖️', '↕️', '↔️', '↪️', '↩️', '⤴️', '⤵️', '🔀', '🔁', '🔂',
      '🔄', '🔃', '🎵', '🎶', '➕', '➖', '➗', '✖️', '♾️', '💲',
      '💱', '™️', '©️', '®️', '👁️‍🗨️', '🔚', '🔙', '🔛', '🔝', '🔜',
      '〰️', '➰', '➿', '✔️', '☑️', '🔘', '🔴', '🟠', '🟡', '🟢',
      '🔵', '🟣', '⚫', '⚪', '🟤', '🔺', '🔻', '🔸', '🔹', '🔶',
      '🔷', '🔳', '🔲', '▪️', '▫️', '◾', '◽', '◼️', '◻️', '🟥',
      '🟧', '🟨', '🟩', '🟦', '🟪', '⬛', '⬜', '🟫', '🔈', '🔇',
      '🔉', '🔊', '🔔', '🔕', '📣', '📢', '💬', '💭', '🗯️', '♠️',
      '♣️', '♥️', '♦️', '🃏', '🎴', '🀄', '🕐', '🕑', '🕒', '🕓',
      '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛', '🕜', '🕝',
      '🕞', '🕟', '🕠', '🕡', '🕢', '🕣', '🕤', '🕥', '🕦', '🕧',
    ],
  },
  flags: {
    name: 'Flags',
    icon: '🏳️',
    emojis: [
      '🏳️', '🏴', '🏴‍☠️', '🏁', '🚩', '🎌', '🏳️‍🌈', '🏳️‍⚧️', '🇺🇳', '🇦🇫',
      '🇦🇱', '🇩🇿', '🇦🇸', '🇦🇩', '🇦🇴', '🇦🇮', '🇦🇶', '🇦🇬', '🇦🇷', '🇦🇲',
      '🇦🇼', '🇦🇺', '🇦🇹', '🇦🇿', '🇧🇸', '🇧🇭', '🇧🇩', '🇧🇧', '🇧🇾', '🇧🇪',
      '🇧🇿', '🇧🇯', '🇧🇲', '🇧🇹', '🇧🇴', '🇧🇦', '🇧🇼', '🇧🇷', '🇮🇴', '🇻🇬',
      '🇧🇳', '🇧🇬', '🇧🇫', '🇧🇮', '🇰🇭', '🇨🇲', '🇨🇦', '🇮🇨', '🇨🇻', '🇧🇶',
      '🇰🇾', '🇨🇫', '🇹🇩', '🇨🇱', '🇨🇳', '🇨🇽', '🇨🇨', '🇨🇴', '🇰🇲', '🇨🇬',
      '🇨🇩', '🇨🇰', '🇨🇷', '🇨🇮', '🇭🇷', '🇨🇺', '🇨🇼', '🇨🇾', '🇨🇿', '🇩🇰',
      '🇩🇯', '🇩🇲', '🇩🇴', '🇪🇨', '🇪🇬', '🇸🇻', '🇬🇶', '🇪🇷', '🇪🇪', '🇸🇿',
      '🇪🇹', '🇪🇺', '🇫🇰', '🇫🇴', '🇫🇯', '🇫🇮', '🇫🇷', '🇬🇫', '🇵🇫', '🇹🇫',
      '🇬🇦', '🇬🇲', '🇬🇪', '🇩🇪', '🇬🇭', '🇬🇮', '🇬🇷', '🇬🇱', '🇬🇩', '🇬🇵',
      '🇬🇺', '🇬🇹', '🇬🇬', '🇬🇳', '🇬🇼', '🇬🇾', '🇭🇹', '🇭🇳', '🇭🇰', '🇭🇺',
      '🇮🇸', '🇮🇳', '🇮🇩', '🇮🇷', '🇮🇶', '🇮🇪', '🇮🇲', '🇮🇱', '🇮🇹', '🇯🇲',
      '🇯🇵', '🎌', '🇯🇪', '🇯🇴', '🇰🇿', '🇰🇪', '🇰🇮', '🇽🇰', '🇰🇼', '🇰🇬',
      '🇱🇦', '🇱🇻', '🇱🇧', '🇱🇸', '🇱🇷', '🇱🇾', '🇱🇮', '🇱🇹', '🇱🇺', '🇲🇴',
      '🇲🇬', '🇲🇼', '🇲🇾', '🇲🇻', '🇲🇱', '🇲🇹', '🇲🇭', '🇲🇶', '🇲🇷', '🇲🇺',
      '🇾🇹', '🇲🇽', '🇫🇲', '🇲🇩', '🇲🇨', '🇲🇳', '🇲🇪', '🇲🇸', '🇲🇦', '🇲🇿',
      '🇲🇲', '🇳🇦', '🇳🇷', '🇳🇵', '🇳🇱', '🇳🇨', '🇳🇿', '🇳🇮', '🇳🇪', '🇳🇬',
      '🇳🇺', '🇳🇫', '🇰🇵', '🇲🇰', '🇲🇵', '🇳🇴', '🇴🇲', '🇵🇰', '🇵🇼', '🇵🇸',
      '🇵🇦', '🇵🇬', '🇵🇾', '🇵🇪', '🇵🇭', '🇵🇳', '🇵🇱', '🇵🇹', '🇵🇷', '🇶🇦',
      '🇷🇪', '🇷🇴', '🇷🇺', '🇷🇼', '🇼🇸', '🇸🇲', '🇸🇹', '🇸🇦', '🇸🇳', '🇷🇸',
      '🇸🇨', '🇸🇱', '🇸🇬', '🇸🇽', '🇸🇰', '🇸🇮', '🇬🇸', '🇸🇧', '🇸🇴', '🇿🇦',
      '🇰🇷', '🇸🇸', '🇪🇸', '🇱🇰', '🇧🇱', '🇸🇭', '🇰🇳', '🇱🇨', '🇵🇲', '🇻🇨',
      '🇸🇩', '🇸🇷', '🇸🇪', '🇨🇭', '🇸🇾', '🇹🇼', '🇹🇯', '🇹🇿', '🇹🇭', '🇹🇱',
      '🇹🇬', '🇹🇰', '🇹🇴', '🇹🇹', '🇹🇳', '🇹🇷', '🇹🇲', '🇹🇨', '🇹🇻', '🇻🇮',
      '🇺🇬', '🇺🇦', '🇦🇪', '🇬🇧', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🏴󠁧󠁢󠁷󠁬󠁳󠁿', '🇺🇸', '🇺🇾', '🇺🇿',
      '🇻🇺', '🇻🇦', '🇻🇪', '🇻🇳', '🇼🇫', '🇪🇭', '🇾🇪', '🇿🇲', '🇿🇼',
    ],
  },
};

type CategoryKey = keyof typeof EMOJI_CATEGORIES | 'custom';

interface EmojiPickerProps {
  visible: boolean;
  onClose: () => void;
  onSelectEmoji: (emoji: string) => void;
  theme: AppTheme;
  customEmojis?: Emoji[]; // Space-specific custom emojis
  /** Render inline (no Modal/backdrop) for hosts that already own a modal —
   *  e.g. the audio-space overlay, where a second Modal can't be shown. */
  embedded?: boolean;
}

export function EmojiPicker({
  visible,
  onClose,
  onSelectEmoji,
  theme,
  customEmojis = [],
  embedded = false,
}: EmojiPickerProps) {
  const { recentEmojis, trackEmoji, refreshRecent } = useEmojiFrecency();
  const [selectedCategory, setSelectedCategory] = useState<CategoryKey>(
    customEmojis.length > 0 ? 'custom' : (recentEmojis.length > 0 ? 'recent' : 'smileys')
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const styles = createStyles(theme, keyboardHeight);

  // Backdrop + panel are animated independently (like BaseModal): the backdrop
  // fades over the whole screen while only the panel slides up from the bottom.
  // The native Modal itself uses animationType="none" so it never slides the
  // backdrop with the content (issue #57). `rendered` keeps the Modal mounted
  // through the close animation.
  const [rendered, setRendered] = useState(visible);
  const backdropAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible) {
      setRendered(true);
      Animated.parallel([
        Animated.timing(backdropAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, damping: 24, stiffness: 240, mass: 0.8 }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(backdropAnim, { toValue: 0, duration: 180, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: SCREEN_HEIGHT, duration: 200, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setRendered(false);
      });
    }
  }, [visible, backdropAnim, slideAnim]);

  // Refresh recent emojis when picker becomes visible
  useEffect(() => {
    if (visible) {
      refreshRecent();
    }
  }, [visible, refreshRecent]);

  // Track keyboard height to position modal above keyboard
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSubscription = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  // Convert custom emojis to PickerEmoji format
  const customPickerEmojis = useMemo((): PickerEmoji[] => {
    return customEmojis.map((e) => ({
      value: e.id, // Use ID for custom emojis (like desktop)
      isCustom: true,
      imgUrl: e.imgUrl,
      name: e.name,
    }));
  }, [customEmojis]);

  // Convert standard emojis to PickerEmoji format
  const getStandardEmojis = useCallback((emojis: string[]): PickerEmoji[] => {
    return emojis.map((e) => ({
      value: e,
      isCustom: false,
      name: e,
    }));
  }, []);

  const handleEmojiPress = useCallback((emoji: PickerEmoji) => {
    // For custom emojis, send the ID; for standard, send the character
    onSelectEmoji(emoji.value);
    // Track usage for frecency (only standard emojis)
    if (!emoji.isCustom) {
      trackEmoji(emoji.value);
    }
    onClose();
  }, [onSelectEmoji, onClose, trackEmoji]);

  // Build categories including custom if available
  const categories = useMemo(() => {
    const standardCategories = Object.entries(EMOJI_CATEGORIES) as [keyof typeof EMOJI_CATEGORIES, typeof EMOJI_CATEGORIES[keyof typeof EMOJI_CATEGORIES]][];

    // Always show Recent first if there are recent emojis
    const result: [CategoryKey, { name: string; icon: string | React.ReactNode }][] = [];

    // Add Recent category first if there are recent emojis
    if (recentEmojis.length > 0) {
      result.push(['recent', { name: 'Recent', icon: '🕐' }]);
    }

    // Add Custom category if there are custom emojis
    if (customEmojis.length > 0) {
      result.push(['custom', { name: 'Custom', icon: '⭐' }]);
    }

    // Add standard categories (excluding 'recent' since we handle it separately)
    result.push(...standardCategories.filter(([key]) => key !== 'recent'));

    return result;
  }, [customEmojis.length, recentEmojis.length]);

  // Get emojis for selected category
  const displayEmojis = useMemo((): PickerEmoji[] => {
    if (selectedCategory === 'custom') {
      return customPickerEmojis;
    }
    if (selectedCategory === 'recent') {
      return getStandardEmojis(recentEmojis);
    }
    if (selectedCategory in EMOJI_CATEGORIES) {
      return getStandardEmojis(EMOJI_CATEGORIES[selectedCategory as keyof typeof EMOJI_CATEGORIES].emojis);
    }
    return [];
  }, [selectedCategory, customPickerEmojis, recentEmojis, getStandardEmojis]);

  // Filter by search if query exists
  const filteredEmojis = useMemo((): PickerEmoji[] => {
    if (!searchQuery) return displayEmojis;

    // Get all standard emojis (deduplicated)
    const allStandardEmojis = Object.values(EMOJI_CATEGORIES)
      .flatMap(cat => cat.emojis)
      .filter((emoji, index, self) => self.indexOf(emoji) === index);

    // Search standard emojis by keywords
    const matchedStandard = searchEmojis(searchQuery, allStandardEmojis)
      .map((e): PickerEmoji => ({ value: e, isCustom: false, name: e }));

    // Search custom emojis by name
    const query = searchQuery.toLowerCase();
    const matchedCustom = customPickerEmojis.filter(
      (e) => e.name?.toLowerCase().includes(query)
    );

    return [...matchedCustom, ...matchedStandard];
  }, [searchQuery, displayEmojis, customPickerEmojis]);

  // Embedded hosts (e.g. audio-space overlay) keep rendering whenever visible;
  // the Modal branch keeps itself mounted through the close animation via
  // `rendered`.
  if (embedded && !visible) return null;
  if (!embedded && !rendered && !visible) return null;

  const panel = (
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Emoji</Text>
            <TouchableOpacity
              onPress={onClose}
              style={styles.closeButton}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Close emoji picker"
            >
              <IconSymbol name="xmark" size={18} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Search */}
          <View style={styles.searchContainer}>
            <TextInput
              style={styles.searchInput}
              placeholder="Search emoji..."
              placeholderTextColor={theme.colors.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
          </View>

          {/* Category tabs — continuous color band with a floating active pill,
              matching the composer's inline emoji panel (no divider borders). */}
          {!searchQuery && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.categoryTabs}
              contentContainerStyle={styles.categoryTabsContent}
              keyboardShouldPersistTaps="always"
            >
              {categories.map(([key, category]) => (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.categoryTab,
                    selectedCategory === key && styles.categoryTabActive,
                  ]}
                  onPress={() => setSelectedCategory(key as CategoryKey)}
                  accessibilityRole="button"
                  accessibilityLabel={category.name}
                >
                  {typeof category.icon === 'string' ? (
                    <Text style={styles.categoryTabEmoji}>{category.icon}</Text>
                  ) : (
                    category.icon
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {/* Emoji grid */}
          <ScrollView
            style={styles.emojiGrid}
            contentContainerStyle={styles.emojiGridContent}
            keyboardShouldPersistTaps="always"
          >
            {filteredEmojis.length === 0 ? (
              <Text style={styles.emptyText}>
                {selectedCategory === 'recent'
                  ? 'No recent emojis'
                  : selectedCategory === 'custom'
                  ? 'No custom emojis'
                  : 'No emojis found'}
              </Text>
            ) : (
              <View style={styles.emojiRow}>
                {filteredEmojis.map((emoji, index) => (
                  <TouchableOpacity
                    key={`${emoji.value}-${index}`}
                    style={styles.emojiButton}
                    onPress={() => handleEmojiPress(emoji)}
                  >
                    {emoji.isCustom && emoji.imgUrl ? (
                      <Image
                        source={{ uri: emoji.imgUrl }}
                        style={styles.customEmojiImage}
                        resizeMode="contain"
                      />
                    ) : (
                      <Text style={styles.emoji}>{emoji.value}</Text>
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </ScrollView>
        </View>
  );

  if (embedded) return panel;

  return (
    <Modal
      visible={rendered}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, { opacity: backdropAnim }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>
        <Animated.View style={{ transform: [{ translateY: slideAnim }] }}>
          {panel}
        </Animated.View>
      </View>
    </Modal>
  );
}

const createStyles = (theme: AppTheme, keyboardHeight: number) => StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  container: {
    // Same surface family as the composer's emoji panel so the reaction picker
    // reads as the same component in both light/dark schemes.
    backgroundColor: theme.colors.composerPillBg,
    borderTopLeftRadius: Skin.radius(16),
    borderTopRightRadius: Skin.radius(16),
    // Clip the search row / category band to the rounded top corners.
    overflow: 'hidden',
    // Match the visual size of the MessageActionSheet that precedes
    // this picker. The action sheet has no explicit cap and grows to
    // fit ~7-9 rows (Reply, React, Quick React, Edit, Pin, Delete,
    // Bookmark, Report) which lands around 70-75% of the screen on a
    // typical phone. 60% felt cramped after the taller sheet
    // dismissed. 85% leaves a small margin to the status bar.
    maxHeight: '85%',
    minHeight: 360,
    marginBottom: keyboardHeight,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Skin.space(16),
    paddingVertical: Skin.space(12),
    // No bottom border — separation comes from the category band's color step
    // below, matching the composer panel (issue #57).
  },
  headerTitle: {
    fontSize: Skin.font(18),
    fontWeight: '600',
    color: theme.colors.textStrong ?? theme.colors.textMain,
  },
  closeButton: {
    padding: Skin.space(4),
  },
  searchContainer: {
    paddingHorizontal: Skin.space(16),
    paddingTop: Skin.space(4),
    paddingBottom: Skin.space(8),
  },
  searchInput: {
    backgroundColor: theme.colors.surface2 ?? theme.colors.surface3,
    borderRadius: Skin.radius(8),
    paddingHorizontal: Skin.space(12),
    paddingVertical: Skin.space(8),
    fontSize: Skin.font(16),
    color: theme.colors.textMain,
  },
  categoryTabs: {
    // Continuous color band (no divider borders), a subtle step off the panel
    // surface — same treatment as the composer's inline emoji panel.
    maxHeight: 48,
    backgroundColor: theme.colors.composerPanelBand,
  },
  categoryTabsContent: {
    paddingHorizontal: Skin.space(6),
    paddingVertical: Skin.space(6),
    alignItems: 'center',
  },
  categoryTab: {
    paddingHorizontal: Skin.space(9),
    paddingVertical: Skin.space(5),
    marginHorizontal: Skin.space(2),
    borderRadius: Skin.radius(10),
  },
  categoryTabActive: {
    // Floating pill one step above the band, matching the composer panel.
    backgroundColor: theme.colors.composerPanelBandActive,
  },
  categoryTabEmoji: {
    fontSize: Skin.font(20),
    // Explicit line-height so the glyph box is tall enough on Android.
    lineHeight: Skin.font(26),
  },
  emojiGrid: {
    flex: 1,
  },
  emojiGridContent: {
    padding: Skin.space(8),
  },
  emojiRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  emojiButton: {
    width: '12.5%', // 8 columns
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emoji: {
    fontSize: Skin.font(28),
  },
  customEmojiImage: {
    width: 28,
    height: 28,
    borderRadius: Skin.radius(4),
  },
  emptyText: {
    textAlign: 'center',
    color: theme.colors.textSubtle,
    marginTop: Skin.space(24),
    fontSize: Skin.font(14),
  },
});

export default EmojiPicker;
