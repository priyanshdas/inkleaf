// SPDX-License-Identifier: GPL-3.0-or-later
//! Command-line wrapper around the core, handy for poking at real files:
//!   cargo run --example ikcli -- inspect file.pdf
//!   cargo run --example ikcli -- redact in.pdf out.pdf '[{"page":0,"rects":[...]}]'
//!   cargo run --example ikcli -- decrypt in.pdf out.pdf [password]
//!   cargo run --example ikcli -- finalize in.pdf out.pdf
//!   cargo run --example ikcli -- font in.pdf out.ttf PAGE NAME
//!   cargo run --example ikcli -- compress in.pdf out.pdf light|balanced|strong
//!   cargo run --example ikcli -- protect in.pdf out.pdf PASSWORD
use std::fs;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let read = |p: &str| fs::read(p).expect("can't read input");
    let result = match args.first().map(String::as_str) {
        Some("inspect") => inkleaf_core::inspect(&read(&args[1]))
            .map(|i| println!("{}", serde_json::to_string_pretty(&i).unwrap())),
        Some("decrypt") => inkleaf_core::decrypt(&read(&args[1]), args.get(3).map_or("", |s| s))
            .map(|out| fs::write(&args[2], out).unwrap()),
        Some("font") => {
            let request = inkleaf_core::FontRequest { page: args[3].parse().unwrap_or(0), name: args[4].clone() };
            inkleaf_core::font_file(&read(&args[1]), &request).map(|(data, info)| {
                fs::write(&args[2], data).unwrap();
                println!("{} {}", info.kind, info.base_font);
            })
        }
        Some("compress") => {
            let level = serde_json::from_str(&format!("\"{}\"", args.get(3).map_or("balanced", |s| s))).expect("bad level");
            inkleaf_core::compress_pdf(&read(&args[1]), level).map(|(out, report)| {
                fs::write(&args[2], out).unwrap();
                println!("{report:?}");
            })
        }
        Some("protect") => {
            let request = inkleaf_core::ProtectRequest {
                user_password: args[3].clone(),
                owner_password: String::new(),
                allow_print: true,
                allow_copy: true,
                allow_edit: false,
            };
            let seed: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_mul(37) ^ (std::process::id() as u8));
            inkleaf_core::protect(&read(&args[1]), &request, &seed).map(|out| fs::write(&args[2], out).unwrap())
        }
        Some("repair") => inkleaf_core::repair(&read(&args[1])).map(|(out, pages)| {
            fs::write(&args[2], out).unwrap();
            println!("{pages} pages");
        }),
        Some("finalize") => inkleaf_core::finalize(&read(&args[1])).map(|out| fs::write(&args[2], out).unwrap()),
        Some("redact") => {
            let jobs: Vec<inkleaf_core::RedactJob> = serde_json::from_str(&args[3]).expect("bad jobs json");
            inkleaf_core::redact(&read(&args[1]), &jobs).map(|(out, report)| {
                fs::write(&args[2], out).unwrap();
                println!("{}", serde_json::to_string_pretty(&report).unwrap());
            })
        }
        _ => Err("usage: ikcli inspect|decrypt|redact|finalize ...".into()),
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
