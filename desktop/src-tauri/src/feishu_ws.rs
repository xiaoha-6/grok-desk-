//! Feishu / Lark long-connection codec (pbbp2) + sync WebSocket loop.
//! Protocol matches open-platform `/callback/ws/endpoint` used by OpenClaw.

use serde_json::{json, Value};
use std::io::ErrorKind;
use std::net::TcpStream;
use std::time::{Duration, Instant};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};

const METHOD_CONTROL: i32 = 0;
const METHOD_DATA: i32 = 1;

pub struct Endpoint {
    pub url: String,
    pub service_id: i32,
    pub ping_interval_secs: u64,
}

#[derive(Debug, Clone, Default)]
pub struct Frame {
    pub seq_id: u64,
    pub log_id: u64,
    pub service: i32,
    pub method: i32,
    pub headers: Vec<(String, String)>,
    pub payload: Vec<u8>,
}

impl Frame {
    fn header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    fn encode(&self) -> Vec<u8> {
        let mut b = Vec::new();
        put_tag(&mut b, 1, 0);
        put_varint(&mut b, self.seq_id);
        put_tag(&mut b, 2, 0);
        put_varint(&mut b, self.log_id);
        put_tag(&mut b, 3, 0);
        put_varint(&mut b, self.service as u64);
        put_tag(&mut b, 4, 0);
        put_varint(&mut b, self.method as u64);
        for (k, v) in &self.headers {
            put_tag(&mut b, 5, 2);
            put_len_delim(&mut b, &encode_header(k, v));
        }
        if !self.payload.is_empty() {
            put_tag(&mut b, 8, 2);
            put_len_delim(&mut b, &self.payload);
        }
        b
    }

    fn decode(data: &[u8]) -> Result<Frame, String> {
        let mut f = Frame::default();
        let mut pos = 0;
        while pos < data.len() {
            let tag = read_varint(data, &mut pos).ok_or("飞书帧损坏")?;
            let field = tag >> 3;
            let wire = (tag & 0x7) as u8;
            match wire {
                0 => {
                    let v = read_varint(data, &mut pos).ok_or("飞书帧损坏")?;
                    match field {
                        1 => f.seq_id = v,
                        2 => f.log_id = v,
                        3 => f.service = v as i32,
                        4 => f.method = v as i32,
                        _ => {}
                    }
                }
                2 => {
                    let len = read_varint(data, &mut pos).ok_or("飞书帧损坏")? as usize;
                    let end = pos.checked_add(len).filter(|e| *e <= data.len()).ok_or("飞书帧损坏")?;
                    let bytes = &data[pos..end];
                    pos = end;
                    match field {
                        5 => f.headers.push(decode_header(bytes)?),
                        8 => f.payload = bytes.to_vec(),
                        _ => {}
                    }
                }
                1 => pos += 8,
                5 => pos += 4,
                _ => return Err("飞书帧类型未知".into()),
            }
        }
        Ok(f)
    }
}

fn put_varint(buf: &mut Vec<u8>, mut v: u64) {
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            b |= 0x80;
        }
        buf.push(b);
        if v == 0 {
            break;
        }
    }
}

fn read_varint(data: &[u8], pos: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        let b = *data.get(*pos)?;
        *pos += 1;
        result |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

fn put_tag(buf: &mut Vec<u8>, field: u32, wire: u8) {
    put_varint(buf, ((field as u64) << 3) | wire as u64);
}

fn put_len_delim(buf: &mut Vec<u8>, bytes: &[u8]) {
    put_varint(buf, bytes.len() as u64);
    buf.extend_from_slice(bytes);
}

fn encode_header(key: &str, value: &str) -> Vec<u8> {
    let mut b = Vec::new();
    put_tag(&mut b, 1, 2);
    put_len_delim(&mut b, key.as_bytes());
    put_tag(&mut b, 2, 2);
    put_len_delim(&mut b, value.as_bytes());
    b
}

fn decode_header(data: &[u8]) -> Result<(String, String), String> {
    let mut key = String::new();
    let mut value = String::new();
    let mut pos = 0;
    while pos < data.len() {
        let tag = read_varint(data, &mut pos).ok_or("飞书头损坏")?;
        if (tag & 0x7) as u8 != 2 {
            return Err("飞书头损坏".into());
        }
        let len = read_varint(data, &mut pos).ok_or("飞书头损坏")? as usize;
        let end = pos.checked_add(len).filter(|e| *e <= data.len()).ok_or("飞书头损坏")?;
        let bytes = &data[pos..end];
        pos = end;
        match tag >> 3 {
            1 => key = String::from_utf8_lossy(bytes).into_owned(),
            2 => value = String::from_utf8_lossy(bytes).into_owned(),
            _ => {}
        }
    }
    Ok((key, value))
}

fn build_ping(service_id: i32) -> Vec<u8> {
    Frame {
        method: METHOD_CONTROL,
        service: service_id,
        headers: vec![("type".into(), "ping".into())],
        ..Default::default()
    }
    .encode()
}

fn build_ack(recv: &Frame) -> Vec<u8> {
    let mut headers = recv.headers.clone();
    headers.push(("biz_rt".into(), "1".into()));
    Frame {
        seq_id: recv.seq_id,
        log_id: recv.log_id,
        service: recv.service,
        method: recv.method,
        headers,
        payload: br#"{"code":200,"headers":null,"data":null}"#.to_vec(),
    }
    .encode()
}

pub fn fetch_endpoint(base: &str, app_id: &str, app_secret: &str) -> Result<Endpoint, String> {
    let url = format!("{}/callback/ws/endpoint", base.trim_end_matches('/'));
    let rec = ureq::post(&url)
        .set("Content-Type", "application/json")
        .set("locale", "zh")
        .set("User-Agent", "GrokDesk-Bridge/0.6.71")
        .send_string(
            &json!({
                "AppID": app_id,
                "AppSecret": app_secret,
                "ClientAssertion": "",
            })
            .to_string(),
        )
        .map_err(|err| err.to_string())?;
    let text = rec.into_string().map_err(|err| err.to_string())?;
    let data: Value = serde_json::from_str(&text).map_err(|err| err.to_string())?;
    parse_endpoint(&data)
}

pub fn parse_endpoint(data: &Value) -> Result<Endpoint, String> {
    let code = data.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        let msg = data.get("msg").and_then(Value::as_str).unwrap_or("飞书长连接失败");
        return Err(format!("{code}: {msg}"));
    }
    let url = data
        .pointer("/data/URL")
        .and_then(Value::as_str)
        .ok_or_else(|| "飞书长连接没有 URL".to_string())?
        .to_string();
    let ping = data
        .pointer("/data/ClientConfig/PingInterval")
        .and_then(Value::as_u64)
        .filter(|item| *item > 0)
        .unwrap_or(120);
    let service_id = url
        .split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .find_map(|pair| pair.strip_prefix("service_id="))
        .and_then(|item| item.parse().ok())
        .unwrap_or(0);
    Ok(Endpoint {
        url,
        service_id,
        ping_interval_secs: ping,
    })
}

fn set_read_timeout(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>, dur: Duration) {
    match socket.get_mut() {
        MaybeTlsStream::NativeTls(stream) => {
            let _ = stream.get_mut().set_read_timeout(Some(dur));
        }
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(dur));
        }
        _ => {}
    }
}

pub fn run_connection(endpoint: &Endpoint, mut on_event: impl FnMut(Value)) -> Result<(), String> {
    let (mut socket, _) = connect(endpoint.url.as_str()).map_err(|err| err.to_string())?;
    set_read_timeout(&mut socket, Duration::from_secs(2));
    let mut last_ping = Instant::now();
    let ping_every = Duration::from_secs(endpoint.ping_interval_secs.max(20));
    loop {
        if last_ping.elapsed() >= ping_every {
            socket
                .send(Message::Binary(build_ping(endpoint.service_id)))
                .map_err(|err| err.to_string())?;
            last_ping = Instant::now();
        }
        match socket.read() {
            Ok(Message::Binary(data)) => {
                let frame = Frame::decode(&data)?;
                if frame.header("type") == Some("ping") {
                    let mut pong = frame.clone();
                    pong.headers = vec![("type".into(), "pong".into())];
                    let _ = socket.send(Message::Binary(pong.encode()));
                    continue;
                }
                if frame.method == METHOD_DATA {
                    if let Ok(value) = serde_json::from_slice::<Value>(&frame.payload) {
                        on_event(value);
                    }
                    let _ = socket.send(Message::Binary(build_ack(&frame)));
                }
            }
            Ok(Message::Ping(data)) => {
                let _ = socket.send(Message::Pong(data));
            }
            Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) => return Ok(()),
            Err(tungstenite::Error::Io(err))
                if err.kind() == ErrorKind::WouldBlock || err.kind() == ErrorKind::TimedOut => {}
            Err(err) => return Err(err.to_string()),
            Ok(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_roundtrip() {
        let raw = build_ping(7);
        let frame = Frame::decode(&raw).expect("decode");
        assert_eq!(frame.method, METHOD_CONTROL);
        assert_eq!(frame.service, 7);
        assert_eq!(frame.header("type"), Some("ping"));
    }

    #[test]
    fn parse_endpoint_url() {
        let data = json!({
            "code": 0,
            "data": { "URL": "wss://msg-ws.feishu.cn/ws?service_id=42", "ClientConfig": { "PingInterval": 60 } }
        });
        let endpoint = parse_endpoint(&data).expect("parse");
        assert_eq!(endpoint.service_id, 42);
        assert_eq!(endpoint.ping_interval_secs, 60);
    }
}
