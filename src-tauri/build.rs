fn main() {
    let dist = std::path::Path::new("../dist");
    println!("cargo:rerun-if-changed=../dist");
    let mut entries=Vec::new();
    fn scan(path:&std::path::Path,root:&std::path::Path,entries:&mut Vec<String>){
        for file in std::fs::read_dir(path).expect("frontend dist unavailable"){let file=file.expect("frontend entry").path();if file.is_dir(){scan(&file,root,entries);}else{let name=file.strip_prefix(root).unwrap().to_string_lossy().replace('\\',"/");let absolute=std::fs::canonicalize(&file).unwrap();entries.push(format!("{name:?} => Some(include_bytes!({:?})),",absolute.to_string_lossy()));}}
    }
    if dist.exists(){scan(dist,dist,&mut entries);}
    std::fs::write(std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("web_assets.rs"),format!("pub fn asset(path:&str)->Option<&'static [u8]> {{match path {{ {} _=>None }} }}",entries.join("\n"))).unwrap();
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
