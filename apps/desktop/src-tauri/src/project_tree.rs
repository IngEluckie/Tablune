//! Logical organization inside a project; item identity and archive paths stay stable.
use super::*;

const MAX_FOLDERS: usize = 10_000;
const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOrganization {
    #[serde(default)]
    pub folders: Vec<ProjectFolder>,
    #[serde(default)]
    pub item_folders: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
}

pub(super) fn folder_name(value: &str) -> Result<String, String> {
    let value = name(value)?;
    if matches!(value.as_str(), "." | "..") || value.contains(['/', '\\']) {
        return Err("El nombre de la carpeta no puede contener rutas, / ni \\".into());
    }
    Ok(value)
}

pub(super) fn item_ids(data: &ProjectData) -> impl Iterator<Item = &String> {
    data.tables
        .iter()
        .map(|t| &t.id)
        .chain(data.scripts.iter().map(|s| &s.id))
        .chain(data.markdown.iter().map(|d| &d.id))
}

pub(super) fn validate(org: &ProjectOrganization, data: &ProjectData) -> Result<(), String> {
    if org.folders.len() > MAX_FOLDERS {
        return Err("El proyecto supera el límite de 10 000 carpetas".into());
    }
    let mut ids: HashSet<&str> = item_ids(data).map(String::as_str).collect();
    ids.insert(&data.id);
    let mut siblings = HashSet::new();
    for folder in &org.folders {
        if folder.id.is_empty()
            || folder.id.len() > 120
            || !folder
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
            || !ids.insert(&folder.id)
        {
            return Err("Invalid or duplicate folder identifier".into());
        }
        folder_name(&folder.name)?;
        if !siblings.insert((folder.parent_id.as_deref(), folder.name.trim())) {
            return Err("Ya existe una carpeta con ese nombre en el destino".into());
        }
    }
    let folders: HashMap<_, _> = org.folders.iter().map(|f| (f.id.as_str(), f)).collect();
    for folder in &org.folders {
        let mut seen = HashSet::new();
        let mut next = Some(folder.id.as_str());
        while let Some(id) = next {
            if !seen.insert(id) {
                return Err(
                    "Una carpeta no puede moverse dentro de sí misma ni de sus subcarpetas".into(),
                );
            }
            if seen.len() > MAX_DEPTH {
                return Err("La profundidad máxima es de 64 carpetas".into());
            }
            next = folders
                .get(id)
                .ok_or("La carpeta de destino ya no existe")?
                .parent_id
                .as_deref();
        }
    }
    let items: HashSet<_> = item_ids(data).map(String::as_str).collect();
    for (item, parent) in &org.item_folders {
        if !items.contains(item.as_str()) || !folders.contains_key(parent.as_str()) {
            return Err("Invalid project item placement".into());
        }
    }
    Ok(())
}

impl ProjectSession {
    pub(super) fn ensure_folder(&self, id: Option<&str>) -> Result<(), String> {
        if id.is_some_and(|id| !self.data.organization.folders.iter().any(|f| f.id == id)) {
            return Err("La carpeta de destino ya no existe".into());
        }
        Ok(())
    }
    pub(super) fn place_item(&mut self, id: String, folder_id: Option<String>) {
        match folder_id {
            Some(parent) => {
                self.data.organization.item_folders.insert(id, parent);
            }
            None => {
                self.data.organization.item_folders.remove(&id);
            }
        }
    }
    pub(super) fn change_organization(
        &mut self,
        update: impl FnOnce(&mut ProjectOrganization) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut next = self.data.organization.clone();
        update(&mut next)?;
        validate(&next, &self.data)?;
        self.data.organization = next;
        Ok(())
    }
}
