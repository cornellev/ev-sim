use zenoh::{
    bytes::ZBytes,
    shm::{
        Defragment, GarbageCollect, PosixShmProviderBackendBinaryHeap, ShmProvider,
        ShmProviderBuilder, ZShm,
    },
    Wait,
};

// The default Talc backend reports available() as zero in Zenoh 1.10.2.
pub type Provider = ShmProvider<PosixShmProviderBackendBinaryHeap>;

pub fn create(size: usize) -> Result<Provider, String> {
    let backend = PosixShmProviderBackendBinaryHeap::builder(size)
        .wait()
        .map_err(|e| e.to_string())?;
    Ok(ShmProviderBuilder::backend(backend).wait())
}

pub fn copy(provider: &Provider, bytes: &[u8]) -> Result<ZBytes, String> {
    let mut buffer = provider
        .alloc(bytes.len())
        .with_policy::<Defragment<GarbageCollect>>()
        .wait()
        .map_err(|e| format!("{e:?}"))?;
    buffer.as_mut().copy_from_slice(bytes);
    let immutable: ZShm = buffer.into();
    Ok(immutable.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_payloads_are_not_recycled() {
        let provider = create(16384).unwrap();
        let initial = provider.available();
        let first = copy(&provider, &[7; 4096]).unwrap();
        let held = first.clone();
        drop(first);
        let mut frames = Vec::new();
        while let Ok(frame) = copy(&provider, &[9; 4096]) {
            frames.push(frame);
        }
        assert_eq!(held.to_bytes().as_ref(), &[7; 4096]);
        drop(frames);
        provider.garbage_collect();
        assert!(copy(&provider, &[1; 4096]).is_ok());
        assert_eq!(held.to_bytes().as_ref(), &[7; 4096]);
        drop(held);
        provider.garbage_collect();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while provider.available() < initial && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
            provider.garbage_collect();
        }
        assert_eq!(provider.available(), initial);
    }
}
