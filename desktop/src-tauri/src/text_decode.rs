use encoding_rs::{Encoding, BIG5, GB18030, GBK, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252};
use std::ffi::OsStr;

pub fn decode_text_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Some(text) = decode_with_bom(bytes) {
        return text;
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return repair_mojibake(text).unwrap_or_else(|| text.to_string());
    }
    pick_legacy_decode(bytes)
}

pub fn decode_os_name(name: &OsStr) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        return decode_text_bytes(name.as_bytes());
    }
    #[cfg(not(unix))]
    {
        let text = name.to_string_lossy();
        repair_mojibake(&text).unwrap_or_else(|| text.into_owned())
    }
}

fn decode_with_bom(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Some(UTF_8.decode(&bytes[3..]).0.into_owned());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Some(UTF_16LE.decode(&bytes[2..]).0.into_owned());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Some(UTF_16BE.decode(&bytes[2..]).0.into_owned());
    }
    None
}

fn likely_double_byte_cjk(bytes: &[u8]) -> bool {
    let mut pairs = 0u32;
    let mut i = 0usize;
    while i < bytes.len() {
        let lead = bytes[i];
        if lead < 0x80 {
            i += 1;
            continue;
        }
        let Some(&trail) = bytes.get(i + 1) else {
            return false;
        };
        if (0x81..=0xFE).contains(&lead) && (0x40..=0xFE).contains(&trail) && trail != 0x7F {
            pairs += 1;
            i += 2;
            continue;
        }
        return false;
    }
    pairs > 0
}

fn pick_legacy_decode(bytes: &[u8]) -> String {
    let order: &[&'static Encoding] = if likely_double_byte_cjk(bytes) {
        &[GB18030, GBK, BIG5, SHIFT_JIS, WINDOWS_1252]
    } else {
        &[WINDOWS_1252, GB18030, GBK, BIG5, SHIFT_JIS]
    };
    let mut best: Option<(u32, String)> = None;
    for enc in order {
        let (score, text) = score_decode(enc, bytes);
        if best.as_ref().is_none_or(|(current, _)| score > *current) {
            best = Some((score, text));
        }
    }
    best.map(|(_, text)| text)
        .unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
}

fn score_decode(enc: &'static Encoding, bytes: &[u8]) -> (u32, String) {
    let (cow, _, had_errors) = enc.decode(bytes);
    let text = cow.into_owned();
    (text_quality(&text, had_errors), text)
}

fn text_quality(text: &str, had_errors: bool) -> u32 {
    let mut cjk = 0u32;
    let mut replacement = 0u32;
    let mut weird = 0u32;
    for ch in text.chars() {
        if ch == '\u{FFFD}' {
            replacement += 1;
        } else if is_cjk(ch) {
            cjk += 1;
        } else if ch.is_control() && !matches!(ch, '\n' | '\r' | '\t') {
            weird += 1;
        }
    }
    let mut score = cjk.saturating_mul(8).saturating_add((text.len() as u32) / 12);
    if had_errors {
        score = score.saturating_sub(2_000);
    }
    score
        .saturating_sub(replacement.saturating_mul(80))
        .saturating_sub(weird.saturating_mul(25))
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch,
        '\u{4E00}'..='\u{9FFF}'
            | '\u{3400}'..='\u{4DBF}'
            | '\u{3040}'..='\u{30FF}'
            | '\u{AC00}'..='\u{D7AF}'
            | '\u{FF00}'..='\u{FFEF}'
    )
}

fn cjk_count(text: &str) -> u32 {
    text.chars().filter(|ch| is_cjk(*ch)).count() as u32
}

fn looks_like_mojibake(text: &str) -> bool {
    let mut total = 0u32;
    let mut high_latin = 0u32;
    let mut cjk = 0u32;
    for ch in text.chars().take(400) {
        total += 1;
        if is_cjk(ch) {
            cjk += 1;
        }
        if matches!(ch, '\u{0080}'..='\u{024F}') {
            high_latin += 1;
        }
    }
    cjk == 0 && high_latin >= 2 && high_latin.saturating_mul(3) >= total.max(1)
}

fn as_latin1_bytes(text: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(text.len());
    for ch in text.chars() {
        let value = ch as u32;
        if value > 0xFF {
            return None;
        }
        bytes.push(value as u8);
    }
    Some(bytes)
}

fn repair_mojibake(text: &str) -> Option<String> {
    if !looks_like_mojibake(text) {
        return None;
    }
    let bytes = as_latin1_bytes(text)?;
    for enc in [GB18030, GBK, BIG5] {
        let (cow, _, had_errors) = enc.decode(&bytes);
        if had_errors {
            continue;
        }
        let repaired = cow.into_owned();
        if cjk_count(&repaired) > cjk_count(text) && !repaired.contains('\u{FFFD}') {
            return Some(repaired);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_utf8_plain() {
        assert_eq!(decode_text_bytes("hello 测试".as_bytes()), "hello 测试");
    }

    #[test]
    fn reads_gbk_chinese() {
        // "测试文件" in GBK
        let bytes = [0xB2, 0xE2, 0xCA, 0xD4, 0xCE, 0xC4, 0xBC, 0xFE];
        assert_eq!(decode_text_bytes(&bytes), "测试文件");
    }

    #[test]
    fn reads_utf16le_bom() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "测试".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text_bytes(&bytes), "测试");
    }

    #[test]
    fn repairs_latin1_mojibake_filename() {
        // GBK bytes for 测试, misread as Latin-1 and stored as Unicode.
        let mojibake: String = [0xB2u8, 0xE2, 0xCA, 0xD4].into_iter().map(char::from).collect();
        assert_eq!(decode_text_bytes(mojibake.as_bytes()), "测试");
    }
}
