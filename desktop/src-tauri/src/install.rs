use crate::runtime::resolve_binary;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(not(target_os = "windows"))]
const INSTALL_SH: &str = "https://x.ai/cli/install.sh";
#[cfg(target_os = "windows")]
const INSTALL_PS1: &str = "https://x.ai/cli/install.ps1";

pub struct InstallEventSink {
    pub on_line: Box<dyn FnMut(String) + Send>,
}

pub fn install_official(mut sink: InstallEventSink, cancel: Arc<AtomicBool>) -> Result<String, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("安装已取消".into());
    }

    #[cfg(target_os = "windows")]
    {
        (sink.on_line)(format!("正在运行官方安装器：{INSTALL_PS1}"));
        let mut command = Command::new("powershell");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://x.ai/cli/install.ps1 | iex",
        ]);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        crate::runtime::hide_console(&mut command);
        let mut child = command
            .spawn()
            .map_err(|err| format!("无法启动 PowerShell：{err}"))?;
        stream_child(&mut child, &mut sink, &cancel)?;
        return finish_install();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let tmp = std::env::temp_dir().join(format!("GrokDesk-Installer-{}", std::process::id()));
        fs::create_dir_all(&tmp).map_err(|err| format!("无法创建临时目录：{err}"))?;
        let script: PathBuf = tmp.join("install.sh");
        (sink.on_line)(format!("正在下载官方安装器：{INSTALL_SH}"));
        let mut download = Command::new("curl")
            .args([
                "--fail",
                "--silent",
                "--show-error",
                "--location",
                crate::runtime::official_installer_url(),
                "--output",
                &script.display().to_string(),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("无法启动 curl：{err}"))?;
        stream_child(&mut download, &mut sink, &cancel)?;
        if cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_dir_all(&tmp);
            return Err("安装已取消".into());
        }
        (sink.on_line)("正在运行官方安装器…".into());
        let mut install = Command::new("bash")
            .arg(&script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("无法启动 bash：{err}"))?;
        let result = stream_child(&mut install, &mut sink, &cancel);
        let _ = fs::remove_dir_all(&tmp);
        result?;
        finish_install()
    }
}

fn stream_child(
    child: &mut std::process::Child,
    sink: &mut InstallEventSink,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if let Some(out) = stdout {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                return Err("安装已取消".into());
            }
            (sink.on_line)(line);
        }
    }
    if let Some(err) = stderr {
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            (sink.on_line)(line);
        }
    }
    let status = child
        .wait()
        .map_err(|err| format!("等待安装进程失败：{err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "官方安装器退出码 {}",
            status.code().unwrap_or(-1)
        ))
    }
}

fn finish_install() -> Result<String, String> {
    resolve_binary()
        .map(|path| path.display().to_string())
        .ok_or_else(|| "安装程序已结束，但没有找到 grok 可执行文件。请重新打开终端后再试。".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn installer_url_is_official() {
        let url = crate::runtime::official_installer_url();
        assert!(url.starts_with("https://x.ai/cli/install."));
    }
}
