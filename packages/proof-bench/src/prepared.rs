//! Two independently verified relations joined by a hiding key commitment.
use crate::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Context {
    pub chain_id: u64,
    pub settlement: [u8; 20],
    pub owner: [u8; 20],
    pub batch: u64,
    pub round: u64,
}
impl From<&Statement> for Context {
    fn from(s: &Statement) -> Self {
        Self {
            chain_id: s.chain_id,
            settlement: s.settlement,
            owner: s.owner,
            batch: s.batch,
            round: s.round,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Preparation {
    pub context: Context,
    pub commitment: [u8; 32],
}
#[derive(Clone, Serialize, Deserialize)]
pub struct PreparationWitness {
    pub key: [u8; 16],
    pub sigma: [u8; 16],
    pub blind: [u8; 32],
    pub wrapper: Vec<u8>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Online {
    pub admission: Statement,
    pub commitment: [u8; 32],
}
#[derive(Clone, Serialize, Deserialize)]
pub struct OnlineWitness {
    pub order: Witness,
    pub blind: [u8; 32],
    pub wrapper: Vec<u8>,
}

pub fn commitment(c: &Context, wrapper: &[u8], key: [u8; 16], blind: [u8; 32]) -> [u8; 32] {
    // All concatenated elements have fixed widths. Configuration is pinned by
    // both guest identities and included explicitly for domain separation.
    hash(
        &[
            hash(b"blindfold.prepared-key.v1").as_slice(),
            &word(c.chain_id.into()),
            &address_word(&c.settlement),
            &address_word(&c.owner),
            &word(c.batch.into()),
            &word(c.round.into()),
            &hash(CHAIN_HASH.as_bytes()),
            &hash(PUBLIC_KEY.as_bytes()),
            &hash(wrapper),
            &key,
            &blind,
        ]
        .concat(),
    )
}

pub fn check_preparation(s: &Preparation, w: &PreparationWitness) -> Result<()> {
    ensure!(
        s.context.round != 0 && w.wrapper.len() == 128,
        "preparation shape"
    );
    ensure!(
        commitment(&s.context, &w.wrapper, w.key, w.blind) == s.commitment,
        "preparation commitment"
    );
    ensure!(
        wrap_key(s.context.round, w.key, w.sigma)? == w.wrapper,
        "preparation wrapper"
    );
    Ok(())
}

pub fn check_online(s: &Online, w: &OnlineWitness) -> Result<()> {
    ensure!(w.wrapper.len() == 128, "wrapper shape");
    // sigma is not used online. Require canonical zero instead of conveying
    // unnecessary encryption randomness to this guest.
    ensure!(w.order.sigma == [0; 16], "online sigma");
    ensure!(
        commitment(
            &Context::from(&s.admission),
            &w.wrapper,
            w.order.file_key,
            w.blind
        ) == s.commitment,
        "online commitment"
    );
    check_payload_and_funding(&s.admission, &w.order, w.wrapper.clone())
}

pub fn check_pair(
    p: &Preparation,
    pw: &PreparationWitness,
    o: &Online,
    ow: &OnlineWitness,
) -> Result<()> {
    ensure!(
        p.context == Context::from(&o.admission) && p.commitment == o.commitment,
        "proof binding"
    );
    check_preparation(p, pw)?;
    check_online(o, ow)
}

/// Fixed 32-byte ABI words; the online journal begins with this exact binding.
pub fn preparation_journal(s: &Preparation) -> Vec<u8> {
    let c = &s.context;
    [
        hash(b"blindfold.prepared-key.v1"),
        word(c.chain_id.into()),
        address_word(&c.settlement),
        address_word(&c.owner),
        word(c.batch.into()),
        word(c.round.into()),
        s.commitment,
        hash(&[CHAIN_HASH.as_bytes(), PUBLIC_KEY.as_bytes()].concat()),
    ]
    .concat()
}
pub fn online_journal(s: &Online) -> Vec<u8> {
    let a = &s.admission;
    let mut out = preparation_journal(&Preparation {
        context: Context::from(a),
        commitment: s.commitment,
    });
    out.extend(
        [
            word(a.step.into()),
            a.old_root,
            a.new_root,
            word(a.budgets[0]),
            word(a.budgets[1]),
            a.order_hash,
            a.ciphertext_hash,
        ]
        .concat(),
    );
    out
}

/// An in-memory AGE encryptor, consumed exactly once when the order is chosen.
/// sigma/blind are explicit to support reproducible synthetic benchmarks.
pub struct Prepared {
    pub statement: Preparation,
    pub witness: PreparationWitness,
    encryptor: age::Encryptor,
}
impl Prepared {
    pub fn new(context: Context, sigma: [u8; 16], blind: [u8; 32]) -> Result<Self> {
        ensure!(context.round != 0, "zero round");
        let recipient = RecordingRecipient {
            round: context.round,
            sigma,
            file_key: Mutex::new([0; 16]),
        };
        let encryptor =
            age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))?;
        let key = *recipient.file_key.lock().unwrap();
        let wrapper = wrap_key(context.round, key, sigma)?;
        let statement = Preparation {
            commitment: commitment(&context, &wrapper, key, blind),
            context,
        };
        Ok(Self {
            statement,
            witness: PreparationWitness {
                key,
                sigma,
                blind,
                wrapper,
            },
            encryptor,
        })
    }

    pub fn finish(self, mut s: Statement, mut w: Witness) -> Result<(Online, OnlineWitness)> {
        ensure!(
            self.statement.context == Context::from(&s),
            "prepared context"
        );
        w.file_key = self.witness.key;
        w.sigma = [0; 16];
        w.ciphertext.clear();
        let mut writer = self.encryptor.wrap_output(&mut w.ciphertext)?;
        // Borrow the plaintext separately from the output buffer.
        let payload = [
            address_word(&s.owner),
            word((w.zero_for_one as u8).into()),
            word(w.amount.into()),
            word(w.minimum.into()),
            w.salt,
        ]
        .concat();
        writer.write_all(&payload)?;
        writer.finish()?;
        s.ciphertext_hash = hash(&w.ciphertext);
        s.order_hash = order_hash(&s, &w);
        Ok((
            Online {
                admission: s,
                commitment: self.statement.commitment,
            },
            OnlineWitness {
                order: w,
                blind: self.witness.blind,
                wrapper: self.witness.wrapper,
            },
        ))
    }
}

pub fn sample_pair(
    direction: bool,
    amount: u128,
    step: u64,
) -> Result<(Preparation, PreparationWitness, Online, OnlineWitness)> {
    let context = Context {
        chain_id: 130,
        settlement: [1; 20],
        owner: [2; 20],
        batch: 7,
        round: 1000,
    };
    let prepared = Prepared::new(context, [6; 16], [7; 32])?;
    let p = prepared.statement.clone();
    let pw = prepared.witness.clone();
    // Order selection and funding witness construction happen after preparation.
    let (s, w) = sample(1000, direction, amount, step)?;
    let (o, ow) = prepared.finish(s, w)?;
    Ok((p, pw, o, ow))
}
