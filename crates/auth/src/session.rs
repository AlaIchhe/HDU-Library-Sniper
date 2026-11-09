use super::*;

impl AuthService {
    pub fn authenticated(&self) -> bool {
        !self.client.uid().is_empty()
    }

    pub fn status(&self) -> SessionStatus {
        let uid = self.client.uid();
        let name = self.client.name();
        SessionStatus {
            authenticated: !uid.is_empty(),
            uid: (!uid.is_empty()).then_some(uid),
            name: (!name.is_empty()).then_some(name),
            refreshing: false,
            last_error: None,
        }
    }

    pub(crate) fn clear_state(&self) {
        self.auth_jar.lock().expect("auth jar poisoned").clear();
        self.client.clear_cookies();
        self.client.set_identity(String::new(), String::new());
    }

    pub(crate) fn sync_cookies_to_client(&self) {
        let cookies = self.auth_jar.lock().expect("auth jar poisoned").all();
        self.client.replace_cookies(cookies);
    }

    pub(crate) fn persist_now(&self) -> Result<(), AuthError> {
        let credentials = self
            .credentials
            .lock()
            .expect("credentials poisoned")
            .clone();
        let openid = self.openid.lock().expect("openid poisoned").clone();
        let cookies = serde_json::to_string(&self.client.jar_snapshot().all())?;
        let mut row = SessionRow {
            uid: self.client.uid(),
            name: self.client.name(),
            student_id: String::new(),
            password: String::new(),
            openid: String::new(),
            cookies,
            updated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            credentials_enc: String::new(),
            credentials_scheme: "plain".into(),
        };
        match self.secrets.as_ref() {
            Some(secrets) if credentials.is_some() || openid.is_some() => {
                let blob = serde_json::to_string(&json!({
                    "student_id": credentials
                        .as_ref()
                        .map(|value| value.student_id.as_str())
                        .unwrap_or_default(),
                    "password": credentials
                        .as_ref()
                        .map(|value| value.password.as_str())
                        .unwrap_or_default(),
                    "openid": openid.as_deref().unwrap_or_default(),
                }))?;
                row.credentials_enc = secrets.seal(&blob)?;
                row.credentials_scheme = secrets.scheme().to_string();
            }
            Some(_) => {}
            None => {
                row.student_id = credentials
                    .as_ref()
                    .map(|value| value.student_id.clone())
                    .unwrap_or_default();
                row.password = credentials
                    .as_ref()
                    .map(|value| value.password.clone())
                    .unwrap_or_default();
                row.openid = openid.unwrap_or_default();
            }
        }
        self.store.save_session(&row)?;
        Ok(())
    }

    pub(crate) async fn persist(&self) -> Result<(), AuthError> {
        self.persist_now()
    }

    pub(crate) async fn rollback(&self, snapshot: SessionSnapshot) {
        self.auth_jar
            .lock()
            .expect("auth jar poisoned")
            .replace_all(snapshot.cookies.clone());
        self.client.replace_cookies(snapshot.cookies);
        self.client.set_identity(snapshot.uid, snapshot.name);
        *self.credentials.lock().expect("credentials poisoned") = snapshot.credentials;
        *self.openid.lock().expect("openid poisoned") = snapshot.openid;
        let _ = self.persist().await;
    }

    pub async fn restore(&self) -> bool {
        if self.client.validate().await {
            return true;
        }
        self.refresh().await
    }

    pub fn install_refresh_callback(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let handler: RefreshHandler = Arc::new(move || {
            let weak = weak.clone();
            let future: Pin<Box<dyn Future<Output = bool> + Send>> = Box::pin(async move {
                match weak.upgrade() {
                    Some(auth) => auth.refresh().await,
                    None => false,
                }
            });
            future
        });
        self.client.set_refresh_handler(handler);
    }

    pub async fn refresh(&self) -> bool {
        if self.refreshing.swap(true, Ordering::SeqCst) {
            return false;
        }
        let result = self.refresh_inner().await;
        self.refreshing.store(false, Ordering::SeqCst);
        result
    }

    async fn refresh_inner(&self) -> bool {
        let credentials = self
            .credentials
            .lock()
            .expect("credentials poisoned")
            .clone();
        if let Some(credentials) = credentials {
            return self
                .login_password_inner(&credentials.student_id, &credentials.password)
                .await
                .map(|result| result.success)
                .unwrap_or(false);
        }
        let openid = self.openid.lock().expect("openid poisoned").clone();
        let Some(openid) = openid else {
            return false;
        };
        self.clear_state();
        match self.exchange_openid(&openid).await {
            Ok(()) => self.persist().await.is_ok(),
            Err(_) => false,
        }
    }

    pub async fn logout(&self) {
        self.clear_state();
        let _ = self.persist().await;
    }
}
